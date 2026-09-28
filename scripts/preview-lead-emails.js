// Prints the 6 emails of the new-business sequence exactly as they will be sent (sends nothing) and saves an HTML copy in tmp/.
//
//   npm run leads:preview-emails                    sample company, Spanish-name signal (latino_strong)
//   npm run leads:preview-emails -- --plain         same but WITHOUT the "comunidad latina" line
//   npm run leads:preview-emails -- --sector otro   sector without a label
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderEmail, SEQUENCE_DAYS, SEQUENCE_LENGTH, firstSubject } from '../src/prompts/newBusinessEmails.js';

const args = process.argv.slice(2);
const val = (flag, dflt) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : dflt);

const lead = {
  name: val('--name', 'Limpieza Rivera LLC'),
  city: 'New Britain',
  sector: val('--sector', 'limpieza'),
  latino_strong: !args.includes('--plain'),
  registered_at: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10),
};
lead.first_subject = firstSubject(lead);

const ctx = {
  formUrl: 'https://TU-DOMINIO/f/EJEMPLO-DE-TOKEN',
  unsubUrl: 'https://TU-DOMINIO/u/EJEMPLO-DE-TOKEN',
  senderName: process.env.OUTREACH_SENDER_NAME || 'Jose',
  companyName: process.env.COMPANY_NAME || '[COMPANY_NAME]',
  companyAddress: process.env.COMPANY_ADDRESS || '[COMPANY_ADDRESS]',
};

const pages = [];
for (let step = 0; step < SEQUENCE_LENGTH; step++) {
  const e = renderEmail(lead, step, ctx);
  console.log(`\n${'═'.repeat(78)}\nEMAIL ${step + 1} de ${SEQUENCE_LENGTH} · día ${SEQUENCE_DAYS[step]}${step ? ' · en el mismo hilo' : ''}\nAsunto: ${e.subject}\n${'─'.repeat(78)}\n${e.text}`);
  pages.push(`<h3 style="font-family:Arial">Email ${step + 1} · día ${SEQUENCE_DAYS[step]} — Asunto: ${e.subject}</h3><div style="border:1px solid #ccc;padding:16px;max-width:640px;margin-bottom:32px">${e.html}</div>`);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '../tmp');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'lead-emails-preview.html');
writeFileSync(file, `<!doctype html><meta charset="utf-8"><body style="margin:24px">${pages.join('\n')}</body>`, 'utf8');
console.log(`\n${'═'.repeat(78)}\nCopia en HTML (ábrela en el navegador): ${file}`);
