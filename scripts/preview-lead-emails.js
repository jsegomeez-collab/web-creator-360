// Prints the email of the new-business campaign: the text to paste into the Instantly campaign, and how it will read for
// a few sample leads. Sends nothing.
//
//   npm run leads:email-template            the version in use (the DEMO one when LEAD_DEMOS=true in your .env)
//   npm run leads:email-template -- --demo  the DEMO version (a link to the lead's own website)
import 'dotenv/config';
import { emailTemplate, templateVariables, renderEmail } from '../src/prompts/newBusinessEmails.js';

const demos = process.argv.includes('--demo') || String(process.env.LEAD_DEMOS || '').trim().toLowerCase() === 'true';
const { subject: EMAIL_SUBJECT, body: EMAIL_BODY } = emailTemplate({ demos });

const line = '═'.repeat(78);
console.log(`${line}\nPEGA ESTO EN LA CAMPAÑA DE INSTANTLY (el asunto y el cuerpo, tal cual, con las {{variables}})\n${line}`);
console.log(`\nAsunto:\n${EMAIL_SUBJECT}\n\nCuerpo:\n${EMAIL_BODY}\n`);
console.log(`Versión: ${demos ? 'DEMO (enlace a su web ya publicada)' : 'clásica (enlace para pedir la llamada)'}`);
console.log(`Variables que Instantly rellena por cada lead: ${templateVariables({ demos }).map(v => `{{${v}}}`).join(', ')}\n`);

const url = 'https://TU-SERVIDOR/c/TOKEN-DEL-LEAD';
const samples = [
  ['Ejemplo 1 · nombre en español, sector conocido', { name: 'LIMPIEZA RIVERA LLC', city: 'New Britain', sector: 'limpieza', latino_strong: true }],
  ['Ejemplo 2 · sin señal fuerte y sector "otro"', { name: 'Acme Trading LLC', city: 'Hartford', sector: 'otro', latino_strong: false }],
];
for (const [title, lead] of samples) {
  const e = renderEmail({ ...lead, demo_url: 'https://limpieza-rivera-ab12.vercel.app' }, url, { demos });
  console.log(`${line}\n${title}\n${line}\nAsunto: ${e.subject}\n\n${e.body}\n`);
}
