import AdmZip from 'adm-zip';
import pdfParse from 'pdf-parse';
import { randomUUID } from 'crypto';

const ATTACHMENT_RE = /([\wÁÉÍÓÚáéíóúÑñ\- .()]+\.(?:jpg|jpeg|png|webp|pdf|PDF|heic|HEIC|docx?|xlsx?|csv))\s*\(archivo adjunto\)/i;
const WHATSAPP_LINE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?:\s*([ap]\.?\s*m\.?)?)?\s*-\s*(.*)$/i;

const EXPENSE_KEYWORDS = [
  'pago', 'pagó', 'pague', 'pagaron', 'factura', 'facturas', 'recibo', 'compra', 'compré', 'gasto', 'gasté',
  'transferencia', 'consignación', 'bancolombia', 'banco', 'retiro', 'anticipo', 'abono', 'silo', 'concentrado',
  'colanta', 'bulto', 'bultos', 'fertilizante', 'agromonos', 'inseminar', 'nomina', 'nómina', 'bonificación',
  'jornal', 'jornales', 'arriendo', 'flete', 'transporte', 'internet', 'pipeta', 'gas', 'arreglo', 'reparación',
  'reparacion', 'servicio técnico', 'servicio tecnico', 'motora', 'agitador', 'alimentador', 'alimentadores',
  'bebedero', 'bebederos', 'comedero', 'canoa', 'alambre', 'cerca', 'intereses', 'interés', 'caja menor'
];

const NOISE_PATTERNS = [
  /cifrados de extremo a extremo/i,
  /creó el grupo/i,
  /te añadió/i,
  /añadió a/i,
  /cambió el asunto/i,
  /cambió la descripción/i,
  /se unió usando/i,
  /salió del grupo/i
];

const CATEGORY_RULES = [
  { category: 'Nómina y personal', terms: ['nomina', 'nómina', 'bonificación', 'bonificacion', 'jornal', 'jornales', 'empleado', 'trabajador'] },
  { category: 'Arriendo', terms: ['arriendo', 'arrendamiento'] },
  { category: 'Insumos agrícolas / abonos', terms: ['abono', 'fertilizante', 'bulto', 'bultos', '34-5-4', 'colanta', 'agromonos', 'urea'] },
  { category: 'Alimentación animal', terms: ['silo', 'concentrado', 'alimento', 'alimentos', 'cuido', 'ganado'] },
  { category: 'Servicios públicos / Internet', terms: ['internet', 'wifi', 'fibra'] },
  { category: 'Servicios / Gas', terms: ['pipeta', 'gas'] },
  { category: 'Transporte / Fletes', terms: ['flete', 'transporte', 'llevada', 'traída', 'traida', 'acarre', 'acarreos'] },
  { category: 'Mantenimiento y equipos', terms: ['arreglo', 'reparación', 'reparacion', 'servicio técnico', 'servicio tecnico', 'motora', 'agitador', 'alimentador', 'alimentadores', 'maquinaria', 'tanque'] },
  { category: 'Infraestructura / mantenimiento finca', terms: ['bebedero', 'bebederos', 'comedero', 'canoa', 'alambre', 'cerca', 'cercas', 'poste', 'madera'] },
  { category: 'Facturas / proveedores', terms: ['factura', 'facturas', 'recibo', 'proveedor'] },
  { category: 'Gastos financieros', terms: ['intereses', 'interés', 'comisión', 'comision', 'cuota manejo'] }
];

const FINCA_RULES = [
  { finca: 'Las Acacias 2', terms: ['las acacias 2', 'acacias 2'] },
  { finca: 'Las Acacias', terms: ['las acacias', 'acacias'] },
  { finca: 'El Peñón', terms: ['el peñón', 'el penon', 'peñón', 'penon'] },
  { finca: 'El Alto', terms: ['el alto'] },
  { finca: 'La Paz', terms: ['la paz'] },
  { finca: 'Sector Cuchilla', terms: ['cuchilla', 'sector cuchilla'] }
];

export async function processWhatsappZip(zipBuffer, originalName) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter(e => !e.isDirectory);

  const files = entries.map(e => ({
    name: e.entryName,
    lower: e.entryName.toLowerCase(),
    size: e.header?.size || 0
  }));

  const chatEntry = entries.find(e => /chat.*\.txt$/i.test(e.entryName)) || entries.find(e => e.entryName.toLowerCase().endsWith('.txt'));
  if (!chatEntry) {
    throw new Error('No encontré el archivo .txt del chat dentro del ZIP. Exporta el chat de WhatsApp incluyendo el archivo de texto.');
  }

  const chatText = readEntryAsText(chatEntry);
  const messages = parseWhatsappChat(chatText);
  const pdfInsights = await extractPdfInsights(entries);
  const candidates = buildExpenseCandidates(messages, files, pdfInsights);
  const summary = buildSummary(candidates, messages, files, originalName, chatEntry.entryName, pdfInsights);

  return {
    processedAt: new Date().toISOString(),
    sourceFile: originalName,
    chatFile: chatEntry.entryName,
    summary,
    candidates,
    pdfInsights,
    warnings: buildWarnings(summary)
  };
}

function readEntryAsText(entry) {
  const buf = entry.getData();
  // WhatsApp exports are usually UTF-8. Keep fallback simple for MVP.
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

function parseWhatsappChat(text) {
  const lines = text.split(/\r?\n/);
  const messages = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const match = line.match(WHATSAPP_LINE_RE);
    if (match) {
      if (current) messages.push(current);
      const [, dd, mm, yyyyRaw, hhRaw, minRaw, ampmRaw, rest] = match;
      const yyyy = normalizeYear(yyyyRaw);
      let hh = Number(hhRaw);
      const ampm = (ampmRaw || '').toLowerCase().replace(/\s|\./g, '');
      if (ampm === 'pm' && hh < 12) hh += 12;
      if (ampm === 'am' && hh === 12) hh = 0;
      const date = new Date(Date.UTC(yyyy, Number(mm) - 1, Number(dd), hh, Number(minRaw)));
      const { sender, message } = splitSenderAndMessage(rest);

      current = {
        id: `MSG-${messages.length + 1}`,
        dateISO: date.toISOString(),
        dateLabel: `${pad(dd)}/${pad(mm)}/${yyyy}`,
        timeLabel: `${pad(hh)}:${pad(minRaw)}`,
        sender,
        text: cleanWhatsAppText(message),
        raw: line
      };
    } else if (current) {
      current.text += `\n${cleanWhatsAppText(line)}`;
      current.raw += `\n${line}`;
    }
  }
  if (current) messages.push(current);

  return messages.filter(m => m.text && !NOISE_PATTERNS.some(re => re.test(m.raw)));
}

function normalizeYear(value) {
  const y = Number(value);
  return y < 100 ? 2000 + y : y;
}

function splitSenderAndMessage(rest) {
  const idx = rest.indexOf(': ');
  if (idx === -1) return { sender: 'Sistema / sin remitente', message: rest };
  return { sender: rest.slice(0, idx), message: rest.slice(idx + 2) };
}

function cleanWhatsAppText(text) {
  return (text || '').replace(/\u200e/g, '').replace(/\u202a|\u202c/g, '').trim();
}

function pad(v) {
  return String(v).padStart(2, '0');
}

async function extractPdfInsights(entries) {
  const pdfEntries = entries.filter(e => e.entryName.toLowerCase().endsWith('.pdf'));
  const insights = [];

  for (const entry of pdfEntries.slice(0, 25)) {
    try {
      const data = await pdfParse(entry.getData());
      const text = normalizeText(data.text || '').slice(0, 4000);
      insights.push({
        fileName: entry.entryName,
        pages: data.numpages || null,
        textPreview: text.slice(0, 700),
        amounts: extractAmounts(text),
        probableCategory: inferCategory(text),
        probableFinca: inferFinca(text),
        probableSupplier: inferSupplier(text)
      });
    } catch (error) {
      insights.push({
        fileName: entry.entryName,
        error: `No se pudo leer PDF en MVP 1: ${error.message}`,
        amounts: []
      });
    }
  }
  return insights;
}

function buildExpenseCandidates(messages, files, pdfInsights) {
  const candidates = [];
  const messageToCandidate = new Map();
  const attachmentOnly = [];

  for (const msg of messages) {
    const attachment = parseAttachment(msg.text);
    const normalized = normalizeText(msg.text);
    const isAttachmentOnly = attachment && normalized.replace(normalizeText(attachment.fileName), '').replace('archivo adjunto', '').trim().length < 10;
    const expenseSignal = hasExpenseSignal(msg.text);

    if (isAttachmentOnly) {
      attachmentOnly.push({ msg, attachment });
      continue;
    }

    if (expenseSignal || attachment) {
      const candidate = candidateFromMessage(msg, attachment);
      candidates.push(candidate);
      messageToCandidate.set(msg.id, candidate);
    }
  }

  // Attach images/PDFs that were sent near a candidate message. If none is near, create pending support candidate.
  for (const item of attachmentOnly) {
    const nearest = findNearestCandidate(item.msg, candidates);
    if (nearest && minutesBetween(item.msg.dateISO, nearest.dateISO) <= 15) {
      nearest.soportes.push(item.attachment.fileName);
      nearest.soporte = 'sí';
      nearest.mensajes_relacionados.push(item.msg.id);
      nearest.estado_soporte = 'con soporte adjunto';
      recomputeCandidateStatus(nearest);
    } else {
      const supportCandidate = candidateFromMessage(item.msg, item.attachment);
      supportCandidate.descripcion = 'Soporte adjunto sin descripción suficiente';
      supportCandidate.categoria = 'Por clasificar';
      supportCandidate.estado = 'incompleto';
      supportCandidate.faltantes = ['descripción del gasto', 'valor', 'categoría', 'finca/centro de costo', 'medio de pago'];
      candidates.push(supportCandidate);
    }
  }

  // Add standalone PDF insights when PDF exists but no chat candidate references it clearly.
  for (const pdf of pdfInsights) {
    const referenced = candidates.some(c => c.soportes.some(s => s.includes(pdf.fileName)) || c.descripcion_original?.includes(pdf.fileName));
    if (!referenced) {
      const amount = pickBestAmount(pdf.amounts);
      const cand = {
        id_gasto: `GAS-${String(candidates.length + 1).padStart(4, '0')}`,
        fuente: 'PDF dentro del ZIP',
        fecha_mensaje: null,
        dateISO: null,
        remitente: null,
        descripcion_original: pdf.fileName,
        descripcion: `Documento PDF detectado: ${pdf.fileName}`,
        valor: amount,
        valores_detectados: pdf.amounts || [],
        categoria: pdf.probableCategory || 'Por clasificar',
        finca: pdf.probableFinca || null,
        medio_pago: null,
        proveedor: pdf.probableSupplier || null,
        soporte: 'sí',
        soportes: [pdf.fileName],
        estado_soporte: 'documento PDF',
        estado_conciliacion: 'pendiente',
        confianza_ia: pdf.amounts?.length ? 0.62 : 0.45,
        mensajes_relacionados: [],
        faltantes: [],
        alertas: ['PDF detectado sin asociación clara a un mensaje de WhatsApp. Revisar si corresponde a un gasto ya registrado.']
      };
      recomputeCandidateStatus(cand);
      candidates.push(cand);
    }
  }

  candidates.sort((a, b) => {
    if (!a.dateISO && !b.dateISO) return a.id_gasto.localeCompare(b.id_gasto);
    if (!a.dateISO) return 1;
    if (!b.dateISO) return -1;
    return new Date(a.dateISO) - new Date(b.dateISO);
  });

  // Reassign IDs after sorting.
  candidates.forEach((c, idx) => c.id_gasto = `GAS-${String(idx + 1).padStart(4, '0')}`);
  return candidates;
}

function candidateFromMessage(msg, attachment) {
  const values = extractAmounts(msg.text);
  const calculated = inferCalculatedTotal(msg.text, values);
  const valor = calculated?.total || pickBestAmount(values);
  const categoria = inferCategory(msg.text);
  const finca = inferFinca(msg.text);
  const medio = inferPaymentMethod(msg.text);
  const provider = inferSupplier(msg.text);

  const cand = {
    id_gasto: `GAS-${randomUUID().slice(0, 8)}`,
    fuente: 'WhatsApp',
    fecha_mensaje: msg.dateLabel,
    hora_mensaje: msg.timeLabel,
    dateISO: msg.dateISO,
    remitente: msg.sender,
    descripcion_original: msg.text,
    descripcion: simplifyDescription(msg.text),
    valor,
    valores_detectados: values,
    calculo_detectado: calculated,
    categoria: categoria || 'Por clasificar',
    finca,
    medio_pago: medio,
    proveedor: provider,
    soporte: attachment ? 'sí' : 'no detectado',
    soportes: attachment ? [attachment.fileName] : [],
    estado_soporte: attachment ? 'con soporte adjunto' : 'sin soporte detectado',
    estado_conciliacion: 'pendiente',
    confianza_ia: estimateConfidence({ valor, categoria, finca, medio, attachment, text: msg.text }),
    mensajes_relacionados: [msg.id],
    faltantes: [],
    alertas: []
  };

  if (calculated) {
    cand.alertas.push(`Cálculo detectado: ${calculated.quantity} x ${formatCOP(calculated.unitValue)} = ${formatCOP(calculated.total)}.`);
  }
  if (values.length > 1 && !calculated) {
    cand.alertas.push('Se detectaron varios valores. Revisar cuál corresponde al total del gasto.');
  }
  recomputeCandidateStatus(cand);
  return cand;
}

function recomputeCandidateStatus(cand) {
  const missing = [];
  if (!cand.valor) missing.push('valor');
  if (!cand.categoria || cand.categoria === 'Por clasificar') missing.push('categoría');
  if (!cand.finca) missing.push('finca/centro de costo');
  if (!cand.medio_pago) missing.push('medio de pago');
  if (!cand.soportes || cand.soportes.length === 0) missing.push('soporte');

  cand.faltantes = missing;

  if (cand.alertas?.some(a => /varios valores|PDF detectado sin asociación/i.test(a))) {
    cand.estado = 'requiere_revision';
  } else if (missing.length === 0) {
    cand.estado = 'completo';
  } else if (missing.length <= 2 && cand.valor) {
    cand.estado = 'parcial';
  } else {
    cand.estado = 'incompleto';
  }

  if (cand.estado === 'completo') cand.semaforo = 'verde';
  else if (cand.estado === 'parcial') cand.semaforo = 'amarillo';
  else if (cand.estado === 'requiere_revision') cand.semaforo = 'rojo';
  else cand.semaforo = 'amarillo';
}

function parseAttachment(text) {
  const match = text.match(ATTACHMENT_RE);
  if (!match) return null;
  const fileName = match[1].trim();
  const lower = fileName.toLowerCase();
  const type = lower.endsWith('.pdf') ? 'pdf' : lower.match(/\.(jpg|jpeg|png|webp|heic)$/) ? 'imagen' : 'archivo';
  return { fileName, type };
}

function hasExpenseSignal(text) {
  const n = normalizeText(text);
  if (extractAmounts(text).length > 0) return true;
  return EXPENSE_KEYWORDS.some(k => n.includes(normalizeText(k)));
}

function extractAmounts(text) {
  const n = text || '';
  const found = [];
  const seen = new Set();
  const patterns = [
    /\$\s*([0-9]{1,3}(?:[.,][0-9]{3})+(?:,[0-9]{1,2})?|[0-9]{5,9}(?:,[0-9]{1,2})?)/g,
    /\b([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?)\b/g,
    /\b([0-9]{5,9})\s*(?:pesos|cop)?\b/gi
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(n)) !== null) {
      const raw = m[1];
      const value = normalizeAmount(raw);
      if (value && value >= 1000 && value <= 500000000 && !seen.has(value + ':' + raw)) {
        seen.add(value + ':' + raw);
        found.push({ raw, value });
      }
    }
  }
  return dedupeAmounts(found);
}

function dedupeAmounts(amounts) {
  const seen = new Set();
  const out = [];
  for (const a of amounts) {
    if (!seen.has(a.value)) {
      seen.add(a.value);
      out.push(a);
    }
  }
  return out;
}

function normalizeAmount(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/\s/g, '');
  // Colombian format: 1.232.140,18 -> 1232140.18
  if (s.includes('.') && s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes('.')) {
    s = s.replace(/\./g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const num = Number(s);
  if (!Number.isFinite(num)) return null;
  return Math.round(num);
}

function pickBestAmount(amounts) {
  if (!amounts || !amounts.length) return null;
  // Prefer the largest value as likely total, but not always perfect. Alert is added when multiple values exist.
  return [...amounts].sort((a, b) => b.value - a.value)[0].value;
}

function inferCalculatedTotal(text, values) {
  const n = normalizeText(text);
  const quantityMatch = n.match(/\b(\d{1,3})\s*(?:bultos?|unidades?|und|canecas?|sacos?)\b/);
  const unitValueMatch = text.match(/\$\s*([0-9]{1,3}(?:[.,][0-9]{3})+(?:,[0-9]{1,2})?|[0-9]{5,9})\s*(?:c\/u|cada uno|unidad)/i);
  if (quantityMatch && unitValueMatch) {
    const quantity = Number(quantityMatch[1]);
    const unitValue = normalizeAmount(unitValueMatch[1]);
    if (quantity && unitValue) return { quantity, unitValue, total: quantity * unitValue };
  }
  return null;
}

function inferCategory(text) {
  const n = normalizeText(text);
  for (const rule of CATEGORY_RULES) {
    if (rule.terms.some(t => n.includes(normalizeText(t)))) return rule.category;
  }
  return null;
}

function inferFinca(text) {
  const n = normalizeText(text);
  for (const rule of FINCA_RULES) {
    if (rule.terms.some(t => n.includes(normalizeText(t)))) return rule.finca;
  }
  return null;
}

function inferPaymentMethod(text) {
  const n = normalizeText(text);
  if (['bancolombia', 'transferencia', 'consignacion', 'consignación', 'banco', 'qr', 'nequi'].some(t => n.includes(t))) return 'Bancolombia / banco';
  if (n.includes('efectivo')) return 'Efectivo';
  if (n.includes('tarjeta')) return 'Tarjeta';
  return null;
}

function inferSupplier(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const known = ['Agromonos', 'Colanta', 'Inseminar', 'Concenagro', 'Bancolombia'];
  for (const k of known) {
    if (normalizeText(clean).includes(normalizeText(k))) return k;
  }
  // Basic invoice supplier hint.
  const proveedorMatch = clean.match(/(?:proveedor|a nombre de|para)\s+([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚáéíóúÑñ .&-]{3,40})/i);
  return proveedorMatch ? proveedorMatch[1].trim() : null;
}

function simplifyDescription(text) {
  let t = (text || '').replace(ATTACHMENT_RE, '').replace(/\s+/g, ' ').trim();
  if (!t) t = 'Soporte adjunto';
  if (t.length > 160) t = t.slice(0, 157) + '...';
  return t;
}

function estimateConfidence({ valor, categoria, finca, medio, attachment, text }) {
  let score = 0.35;
  if (valor) score += 0.18;
  if (categoria) score += 0.16;
  if (finca) score += 0.12;
  if (medio) score += 0.08;
  if (attachment) score += 0.08;
  if (extractAmounts(text).length > 1) score -= 0.08;
  return Math.max(0.1, Math.min(0.95, Number(score.toFixed(2))));
}

function findNearestCandidate(msg, candidates) {
  if (!candidates.length) return null;
  const time = new Date(msg.dateISO).getTime();
  let best = null;
  let bestDiff = Infinity;
  for (const c of candidates) {
    if (!c.dateISO) continue;
    const diff = Math.abs(new Date(c.dateISO).getTime() - time);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

function minutesBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60000;
}

function buildSummary(candidates, messages, files, originalName, chatName, pdfInsights) {
  const imageCount = files.filter(f => /\.(jpg|jpeg|png|webp|heic)$/i.test(f.name)).length;
  const pdfCount = files.filter(f => /\.pdf$/i.test(f.name)).length;
  const byStatus = groupCount(candidates, 'estado');
  const byCategory = groupSum(candidates, 'categoria');
  const byFinca = groupSum(candidates, 'finca');
  const totalDetected = candidates.reduce((acc, c) => acc + (Number(c.valor) || 0), 0);
  const missingCounter = {};
  for (const c of candidates) for (const m of c.faltantes || []) missingCounter[m] = (missingCounter[m] || 0) + 1;

  const requiredFields = candidates.length * 5;
  const missingFields = Object.values(missingCounter).reduce((a, b) => a + b, 0);
  const quality = requiredFields ? Math.max(0, Math.round(((requiredFields - missingFields) / requiredFields) * 100)) : 0;

  return {
    originalName,
    chatName,
    totalFiles: files.length,
    imageCount,
    pdfCount,
    pdfReadCount: pdfInsights.filter(p => !p.error).length,
    messageCount: messages.length,
    candidateCount: candidates.length,
    totalDetected,
    qualityScore: quality,
    byStatus,
    byCategory,
    byFinca,
    missingCounter
  };
}

function buildWarnings(summary) {
  const warnings = [];
  if (summary.qualityScore < 70) {
    warnings.push('La calidad de información está por debajo de 70/100. Este cierre requiere revisión humana antes de conciliar.');
  }
  if ((summary.missingCounter?.valor || 0) > 0) warnings.push(`Hay ${summary.missingCounter.valor} gastos sin valor detectado.`);
  if ((summary.missingCounter?.['finca/centro de costo'] || 0) > 0) warnings.push(`Hay ${summary.missingCounter['finca/centro de costo']} gastos sin finca o centro de costo.`);
  if ((summary.missingCounter?.['medio de pago'] || 0) > 0) warnings.push(`Hay ${summary.missingCounter['medio de pago']} gastos sin medio de pago.`);
  return warnings;
}

function groupCount(items, key) {
  return items.reduce((acc, item) => {
    const k = item[key] || 'Sin dato';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function groupSum(items, key) {
  return items.reduce((acc, item) => {
    const k = item[key] || 'Sin dato';
    if (!acc[k]) acc[k] = { count: 0, total: 0 };
    acc[k].count += 1;
    acc[k].total += Number(item.valor || 0);
    return acc;
  }, {});
}

function normalizeText(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function formatCOP(value) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value || 0);
}
