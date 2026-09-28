// Prints the email of the new-business campaign: the text to paste into the Instantly campaign, and how it will read for
// a few sample leads. Sends nothing.
//
//   npm run leads:email-template
import { EMAIL_SUBJECT, EMAIL_BODY, templateVariables, renderEmail } from '../src/prompts/newBusinessEmails.js';

const line = '═'.repeat(78);
console.log(`${line}\nPEGA ESTO EN LA CAMPAÑA DE INSTANTLY (el asunto y el cuerpo, tal cual, con las {{variables}})\n${line}`);
console.log(`\nAsunto:\n${EMAIL_SUBJECT}\n\nCuerpo:\n${EMAIL_BODY}\n`);
console.log(`Variables que Instantly rellena por cada lead: ${templateVariables().map(v => `{{${v}}}`).join(', ')}\n`);

const url = 'https://TU-SERVIDOR/c/TOKEN-DEL-LEAD';
const samples = [
  ['Ejemplo 1 · nombre en español, sector conocido', { name: 'LIMPIEZA RIVERA LLC', city: 'New Britain', sector: 'limpieza', latino_strong: true }],
  ['Ejemplo 2 · sin señal fuerte y sector "otro"', { name: 'Acme Trading LLC', city: 'Hartford', sector: 'otro', latino_strong: false }],
];
for (const [title, lead] of samples) {
  const e = renderEmail(lead, url);
  console.log(`${line}\n${title}\n${line}\nAsunto: ${e.subject}\n\n${e.body}\n`);
}
