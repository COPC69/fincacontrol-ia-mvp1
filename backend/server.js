import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import whatsappRoutes from './routes/whatsapp.js';

const app = express();
const PORT = process.env.PORT || 10000;
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({
  origin: allowedOrigin === '*' ? true : allowedOrigin,
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'FincaControl IA API',
    version: '1.0.0',
    description: 'MVP 1: procesa ZIP de WhatsApp y detecta gastos candidatos'
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.use('/api', whatsappRoutes);

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  const status = err.status || 500;
  res.status(status).json({
    ok: false,
    error: err.message || 'Error interno del servidor'
  });
});

app.listen(PORT, () => {
  console.log(`FincaControl IA API running on port ${PORT}`);
});
