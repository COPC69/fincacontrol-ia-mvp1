import express from 'express';
import multer from 'multer';
import { processWhatsappZip } from '../services/whatsappProcessor.js';

const router = express.Router();
const maxMb = Number(process.env.MAX_UPLOAD_MB || 120);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxMb * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const isZip = file.originalname.toLowerCase().endsWith('.zip') || file.mimetype.includes('zip');
    if (!isZip) return cb(new Error('Debes subir un archivo .zip exportado desde WhatsApp'));
    cb(null, true);
  }
});

router.post('/process-whatsapp-zip', upload.single('zip'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No se recibió ningún ZIP. Usa el campo de archivo llamado zip.' });
    }

    const result = await processWhatsappZip(req.file.buffer, req.file.originalname);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

export default router;
