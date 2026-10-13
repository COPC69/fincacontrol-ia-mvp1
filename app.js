let currentResult = null;
let currentFilter = 'all';

const els = {
  apiUrl: document.getElementById('apiUrl'),
  saveApiUrl: document.getElementById('saveApiUrl'),
  testApi: document.getElementById('testApi'),
  apiStatus: document.getElementById('apiStatus'),
  zipInput: document.getElementById('zipInput'),
  fileName: document.getElementById('fileName'),
  processBtn: document.getElementById('processBtn'),
  exportCsv: document.getElementById('exportCsv'),
  resetBtn: document.getElementById('resetBtn'),
  loading: document.getElementById('loading'),
  errorBox: document.getElementById('errorBox'),
  results: document.getElementById('results'),
  qualityScore: document.getElementById('qualityScore'),
  metricsGrid: document.getElementById('metricsGrid'),
  warnings: document.getElementById('warnings'),
  expensesBody: document.getElementById('expensesBody'),
  rawJson: document.getElementById('rawJson')
};

init();

function init() {
  const saved = localStorage.getItem('FINCACONTROL_API_URL') || defaultApiUrl();
  els.apiUrl.value = saved;

  els.saveApiUrl.addEventListener('click', saveApiUrl);
  els.testApi.addEventListener('click', testBackend);
  els.zipInput.addEventListener('change', onFileChange);
  els.processBtn.addEventListener('click', processZip);
  els.exportCsv.addEventListener('click', exportCsv);
  els.resetBtn.addEventListener('click', resetAll);

  document.querySelectorAll('.filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderExpenses();
    });
  });
}

function defaultApiUrl() {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return 'http://localhost:10000';
  return '';
}

function getApiUrl() {
  return els.apiUrl.value.trim().replace(/\/$/, '');
}

function saveApiUrl() {
  const value = getApiUrl();
  if (!value) return showError('Pega primero la URL de Render. Ejemplo: https://fincacontrol-api.onrender.com');
  localStorage.setItem('FINCACONTROL_API_URL', value);
  setStatus('URL guardada', 'ok');
}

async function testBackend() {
  hideError();
  const base = getApiUrl();
  if (!base) return showError('Pega la URL de Render antes de probar el backend.');
  setStatus('Probando backend...', '');
  try {
    const res = await fetch(`${base}/health`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'El backend no respondió correctamente.');
    setStatus('Backend conectado', 'ok');
  } catch (error) {
    setStatus('Backend con error', 'bad');
    showError(`No pude conectar con el backend. Revisa URL, Render activo y CORS. Detalle: ${error.message}`);
  }
}

function onFileChange() {
  const file = els.zipInput.files?.[0];
  els.fileName.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : 'Ningún archivo seleccionado';
}

async function processZip() {
  hideError();
  const base = getApiUrl();
  const file = els.zipInput.files?.[0];

  if (!base) return showError('Pega y guarda la URL de Render antes de procesar.');
  if (!file) return showError('Selecciona primero un ZIP exportado desde WhatsApp.');
  if (!file.name.toLowerCase().endsWith('.zip')) return showError('El archivo debe ser .zip');

  saveApiUrl();
  els.loading.classList.remove('hidden');
  els.results.classList.add('hidden');
  els.processBtn.disabled = true;
  els.exportCsv.disabled = true;

  try {
    const formData = new FormData();
    formData.append('zip', file);

    const res = await fetch(`${base}/api/process-whatsapp-zip`, {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Error procesando el ZIP');

    currentResult = data;
    renderResult(data);
    setStatus('ZIP procesado', 'ok');
  } catch (error) {
    showError(`No se pudo procesar el ZIP. Detalle: ${error.message}`);
    setStatus('Error procesando', 'bad');
  } finally {
    els.loading.classList.add('hidden');
    els.processBtn.disabled = false;
  }
}

function renderResult(data) {
  const s = data.summary || {};
  els.results.classList.remove('hidden');
  els.exportCsv.disabled = !(data.candidates || []).length;
  els.qualityScore.textContent = `${s.qualityScore || 0}/100`;

  const metrics = [
    ['Gastos candidatos', s.candidateCount || 0],
    ['Mensajes leídos', s.messageCount || 0],
    ['Archivos totales', s.totalFiles || 0],
    ['Imágenes', s.imageCount || 0],
    ['PDFs', `${s.pdfReadCount || 0}/${s.pdfCount || 0}`],
    ['Total detectado', formatCOP(s.totalDetected || 0)],
    ['Completos', s.byStatus?.completo || 0],
    ['Incompletos', s.byStatus?.incompleto || 0],
    ['Requieren revisión', s.byStatus?.requiere_revision || 0]
  ];

  els.metricsGrid.innerHTML = metrics.map(([label, value]) => `
    <div class="metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>
  `).join('');

  els.warnings.innerHTML = (data.warnings || []).map(w => `<div class="warning">⚠️ ${escapeHtml(w)}</div>`).join('');
  if (!data.warnings?.length) els.warnings.innerHTML = '<div class="warning">No hay advertencias críticas en este procesamiento inicial.</div>';

  els.rawJson.textContent = JSON.stringify({ summary: data.summary, warnings: data.warnings, pdfInsights: data.pdfInsights }, null, 2);
  renderExpenses();
}

function renderExpenses() {
  if (!currentResult) return;
  let rows = currentResult.candidates || [];
  if (currentFilter !== 'all') rows = rows.filter(r => r.estado === currentFilter);

  els.expensesBody.innerHTML = rows.map(row => `
    <tr>
      <td><span class="badge ${escapeHtml(row.semaforo || 'amarillo')}">${escapeHtml(row.estado || 'pendiente')}</span><div class="small">Conf. ${Math.round((row.confianza_ia || 0) * 100)}%</div></td>
      <td>${escapeHtml(row.fecha_mensaje || 'Sin fecha')}</td>
      <td><strong>${escapeHtml(row.descripcion || '')}</strong><div class="small">${escapeHtml(row.descripcion_original || '')}</div>${renderAlerts(row.alertas)}</td>
      <td>${row.valor ? formatCOP(row.valor) : '<span class="small">Pendiente</span>'}</td>
      <td>${escapeHtml(row.categoria || 'Por clasificar')}</td>
      <td>${escapeHtml(row.finca || 'Pendiente')}</td>
      <td>${escapeHtml(row.medio_pago || 'Pendiente')}</td>
      <td>${renderMissing(row.faltantes)}</td>
      <td>${renderSupports(row.soportes)}</td>
    </tr>
  `).join('');

  if (!rows.length) {
    els.expensesBody.innerHTML = '<tr><td colspan="9" class="small">No hay registros para este filtro.</td></tr>';
  }
}

function renderAlerts(alerts = []) {
  if (!alerts.length) return '';
  return alerts.map(a => `<div class="small">⚠️ ${escapeHtml(a)}</div>`).join('');
}

function renderMissing(missing = []) {
  if (!missing.length) return '<span class="small">Sin faltantes</span>';
  return missing.map(m => `<span class="small">• ${escapeHtml(m)}</span>`).join('<br>');
}

function renderSupports(supports = []) {
  if (!supports.length) return '<span class="small">Sin soporte</span>';
  return supports.slice(0, 4).map(s => `<span class="small">📎 ${escapeHtml(s)}</span>`).join('<br>') + (supports.length > 4 ? `<br><span class="small">+${supports.length - 4} más</span>` : '');
}

function exportCsv() {
  if (!currentResult?.candidates?.length) return;
  const columns = ['id_gasto','fecha_mensaje','hora_mensaje','descripcion','valor','categoria','finca','medio_pago','proveedor','estado','faltantes','soportes','descripcion_original'];
  const csv = [columns.join(',')].concat(currentResult.candidates.map(row => {
    return columns.map(col => {
      let value = row[col];
      if (Array.isArray(value)) value = value.join(' | ');
      if (value && typeof value === 'object') value = JSON.stringify(value);
      return csvEscape(value ?? '');
    }).join(',');
  })).join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gastos-candidatos-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function resetAll() {
  currentResult = null;
  els.zipInput.value = '';
  els.fileName.textContent = 'Ningún archivo seleccionado';
  els.results.classList.add('hidden');
  els.exportCsv.disabled = true;
  hideError();
}

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.classList.remove('hidden');
}

function hideError() {
  els.errorBox.classList.add('hidden');
  els.errorBox.textContent = '';
}

function setStatus(message, type) {
  els.apiStatus.textContent = message;
  els.apiStatus.className = 'status-pill';
  if (type) els.apiStatus.classList.add(type);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, idx)).toFixed(1)} ${units[idx]}`;
}

function formatCOP(value) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(value || 0));
}

function csvEscape(value) {
  const s = String(value).replace(/"/g, '""');
  return `"${s}"`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
