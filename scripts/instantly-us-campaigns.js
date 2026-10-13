// Puts the emails of the "americanos" campaigns (English) into Instantly, from src/prompts/. Safe to run again: it just rewrites them.
//   npm run instantly:us-campaigns -- --dry-run   shows what it would write, changes nothing
//   npm run instantly:us-campaigns                writes it
// It updates two campaigns:
//   INSTANTLY_CAMPAIGN_ID_US            email 1 + 3 reminders (days 2, 4, 7) for those who have NOT opened their website
//   INSTANTLY_CAMPAIGN_ID_FOLLOWUP_US   7 emails, one a day, for those who DID open it. If this one is empty, it is created by
//                                       duplicating the Spanish follow-up campaign (same settings) and its id is printed: put it in .env and Render.
// Nothing is launched: campaigns stay as they are (draft/paused) until you start them in Instantly.
import 'dotenv/config';
import { EMAIL_SUBJECT_US, EMAIL_BODY_US } from '../src/prompts/newBusinessEmails.js';
import { REMINDERS_US, OPENED_US, toStep } from '../src/prompts/followupEmailsUs.js';
import { API } from '../src/services/instantly.js';

const dryRun = process.argv.includes('--dry-run');
const apiKey = (process.env.INSTANTLY_API_KEY || '').trim();
const mainId = (process.env.INSTANTLY_CAMPAIGN_ID_US || '').trim();
let followId = (process.env.INSTANTLY_CAMPAIGN_ID_FOLLOWUP_US || '').trim();
const spanishFollowId = (process.env.INSTANTLY_CAMPAIGN_ID_FOLLOWUP || '').trim();

const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
async function call(path, method, body) {
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`Instantly respondió ${res.status} en ${method} ${path}: ${json.message || json.error || json.raw || ''}`);
  return json;
}

try {
  if (!apiKey) throw new Error('Falta INSTANTLY_API_KEY en tu .env');
  if (!mainId) throw new Error('Falta INSTANTLY_CAMPAIGN_ID_US en tu .env (la campaña de americanos)');

  const mainSteps = [toStep({ delay: 0, subject: EMAIL_SUBJECT_US, body: EMAIL_BODY_US }), ...REMINDERS_US.map(toStep)];
  const followSteps = OPENED_US.map(toStep);
  console.log(`Campaña de americanos (${mainId.slice(0, 8)}…): ${mainSteps.length} emails → día 0` + REMINDERS_US.reduce((acc, r) => { acc.d += r.delay; acc.s += `, día ${acc.d}`; return acc; }, { d: 0, s: '' }).s);
  console.log(`Seguimiento de los que abren la web: ${followSteps.length} emails, uno al día`);
  if (dryRun) { console.log('\n(vista previa: no se ha cambiado nada en Instantly)'); process.exit(0); }

  await call(`/campaigns/${mainId}`, 'PATCH', { sequences: [{ steps: mainSteps }] });
  console.log('✓ campaña de americanos actualizada');

  if (!followId) {
    if (!spanishFollowId) throw new Error('Para crear el seguimiento en inglés hace falta INSTANTLY_CAMPAIGN_ID_FOLLOWUP (se duplican sus ajustes) o INSTANTLY_CAMPAIGN_ID_FOLLOWUP_US');
    const copy = await call(`/campaigns/${spanishFollowId}/duplicate`, 'POST', { name: 'LLCs Americanos · Seguimiento (EN)' });
    followId = copy.id;
    console.log(`✓ campaña de seguimiento creada: INSTANTLY_CAMPAIGN_ID_FOLLOWUP_US=${followId}`);
  }
  await call(`/campaigns/${followId}`, 'PATCH', { name: 'LLCs Americanos · Seguimiento (EN)', sequences: [{ steps: followSteps }] });
  console.log('✓ seguimiento en inglés actualizado');

  // Check from Instantly itself
  for (const [label, id, expected] of [['americanos', mainId, mainSteps.length], ['seguimiento EN', followId, followSteps.length]]) {
    const c = await call(`/campaigns/${id}`, 'GET');
    const steps = c.sequences?.[0]?.steps || [];
    console.log(`  ${label}: status ${c.status} · ${steps.length}/${expected} pasos · stop_on_reply ${c.stop_on_reply} · asuntos: ${steps.map(s => s.variants?.[0]?.subject).join(' | ').slice(0, 220)}`);
    if (steps.length !== expected) throw new Error(`${label}: Instantly guardó ${steps.length} pasos y debían ser ${expected}`);
  }
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
}
