// Creates in Instantly the webhook that reports what happens to each lead (sent, bounced, unsubscribed, replied) to our
// public campaign server.
//
//   npm run instantly:webhook -- https://tu-servidor.onrender.com
//
// Needs INSTANTLY_API_KEY, INSTANTLY_CAMPAIGN_ID and INSTANTLY_WEBHOOK_SECRET in your .env (and the same secret on the server).
import 'dotenv/config';
import { randomBytes } from 'crypto';
import { loadInstantlyConfig, createWebhook } from '../src/services/instantly.js';

async function main() {
  const base = (process.argv[2] || '').replace(/\/+$/, '');
  if (!base) throw new Error('Uso: npm run instantly:webhook -- https://URL-PÚBLICA-DEL-SERVIDOR');

  const secret = (process.env.INSTANTLY_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    throw new Error(`Falta INSTANTLY_WEBHOOK_SECRET. Añade esta línea a tu .env (y a las variables del servidor) y repite:\n\n  INSTANTLY_WEBHOOK_SECRET=${randomBytes(24).toString('hex')}\n`);
  }
  const config = loadInstantlyConfig(process.env, { dryRun: true });   // solo hacen falta la clave y la campaña
  if (!config.apiKey || !config.campaignId) throw new Error('Faltan INSTANTLY_API_KEY o INSTANTLY_CAMPAIGN_ID en tu .env');

  const created = await createWebhook({ config, targetUrl: `${base}/webhooks/instantly`, secret });
  console.log(`✓ Webhook creado en Instantly (id ${created.id ?? 'desconocido'}) → ${base}/webhooks/instantly`);
  console.log('  Si lo repites se crearía uno duplicado: bórralo en Instantly → Settings → Integrations → Webhooks.');
}

main().catch((err) => { console.error(`\n✗ ${err.message}`); process.exitCode = 1; });
