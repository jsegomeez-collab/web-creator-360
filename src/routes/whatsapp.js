import { Router } from 'express';
import { ensureInstance, getConnectionState, getQR, logout, sendText } from '../services/whatsapp.js';

const router = Router();

// GET /api/whatsapp/status — current state + QR if pending
router.get('/status', async (req, res) => {
  const state = await getConnectionState();
  const qr = state !== 'open' ? await getQR() : null;
  res.json({ state, qr });
});

// POST /api/whatsapp/connect — start / reconnect
router.post('/connect', async (req, res) => {
  try {
    await ensureInstance();
    const state = await getConnectionState();
    const qr = await getQR();
    res.json({ success: true, state, qr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/whatsapp/test — send test message
router.post('/test', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    await sendText(phone, message || 'Test desde Web Creator 360 🚀');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/whatsapp/disconnect — logout
router.delete('/disconnect', async (req, res) => {
  try {
    await logout();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
