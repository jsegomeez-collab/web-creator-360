import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const { Client, LocalAuth } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── State ────────────────────────────────────────────────────────────────────
let client = null;
let _state = 'DISCONNECTED'; // DISCONNECTED | INITIALIZING | QR_READY | CONNECTED
let _qrDataUrl = null;

// ─── Client factory ───────────────────────────────────────────────────────────
function createClient() {
  // Use system Edge (always available on Windows 11) instead of downloading Chrome
  const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

  const c = new Client({
    authStrategy: new LocalAuth({
      dataPath: join(__dirname, '../../.wwebjs_auth'),
    }),
    puppeteer: {
      headless: true,
      executablePath: EDGE_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  });

  c.on('qr', async (qr) => {
    _qrDataUrl = await qrcode.toDataURL(qr);
    _state = 'QR_READY';
    console.log('[whatsapp] QR listo — escanea con tu teléfono');
  });

  c.on('authenticated', () => {
    console.log('[whatsapp] Autenticado');
  });

  c.on('ready', () => {
    _state = 'CONNECTED';
    _qrDataUrl = null;
    console.log('[whatsapp] ✓ Conectado y listo');
  });

  c.on('auth_failure', (msg) => {
    _state = 'DISCONNECTED';
    _qrDataUrl = null;
    console.error('[whatsapp] Auth failure:', msg);
  });

  c.on('disconnected', (reason) => {
    _state = 'DISCONNECTED';
    _qrDataUrl = null;
    client = null;
    console.log('[whatsapp] Desconectado:', reason);
  });

  return c;
}

// ─── Public API (same interface as Evolution API wrapper) ─────────────────────

export async function isAvailable() {
  return true; // always available (in-process, no external service)
}

export async function ensureInstance() {
  if (client || _state === 'INITIALIZING') return;
  _state = 'INITIALIZING';
  client = createClient();
  // Initialize in background — state updates via event handlers
  client.initialize().catch(err => {
    console.error('[whatsapp] Initialize error:', err.message);
    _state = 'DISCONNECTED';
    client = null;
  });
}

export async function getConnectionState() {
  if (_state === 'CONNECTED') return 'open';
  if (_state === 'QR_READY' || _state === 'INITIALIZING') return 'connecting';
  return 'close';
}

export async function getQR() {
  return _qrDataUrl;
}

export async function logout() {
  if (!client) return;
  try { await client.logout(); } catch {}
  try { await client.destroy(); } catch {}
  client = null;
  _state = 'DISCONNECTED';
  _qrDataUrl = null;
  console.log('[whatsapp] Sesión cerrada');
}

export async function sendText(phone, message) {
  if (_state !== 'CONNECTED' || !client) throw new Error('WhatsApp no está conectado');
  const chatId = formatPhone(phone) + '@c.us';
  await client.sendMessage(chatId, message);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatPhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  // Strip leading 00 (alternative international prefix)
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Already has country code (11+ digits or starts with known prefix)
  if (digits.length >= 11) return digits;
  // US/Canada: 10 digits starting with 2-9 → add 1
  if (digits.length === 10 && /^[2-9]/.test(digits)) return '1' + digits;
  // Spanish mobile: 9 digits starting with 6 or 7 → add 34
  if (digits.length === 9 && /^[67]/.test(digits)) return '34' + digits;
  // Spanish landline: 9 digits starting with 9 → add 34
  if (digits.length === 9 && digits.startsWith('9')) return '34' + digits;
  return digits;
}

export function buildMessage(business, site, language = 'es') {
  const name = business.name;
  const url = site.preview_url;
  if (language === 'en') {
    return [
      `Hi 👋`,
      `We built a website for *${name}* — customized with your services and brand.`,
      `Take a look: ${url}`,
      `If you like it, we can activate it on your domain for just *$497*. No commitments.`,
      `Just reply if you have any questions 😊`,
    ].join('\n\n');
  }
  return [
    `Hola 👋`,
    `Hemos creado una web para *${name}* — personalizada con sus servicios e imagen de marca.`,
    `Puede verla aquí: ${url}`,
    `Si le gusta, por solo *$497* la activamos en su dominio. Sin permanencia.`,
    `Responda a este mensaje si tiene alguna pregunta 😊`,
  ].join('\n\n');
}
