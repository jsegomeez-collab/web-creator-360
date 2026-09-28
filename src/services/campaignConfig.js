// Settings every cold email needs. Real sends are refused without a public https BASE_URL (the links in the email point
// there) and the company name + postal address (CAN-SPAM). In dry-run placeholders are used so a cycle can still be tested.
import { isDryRun } from '../lib/dryRun.js';

export function loadCampaignConfig(env = process.env, { dryRun = isDryRun() } = {}) {
  const baseUrl = String(env.BASE_URL || '').trim().replace(/\/+$/, '');
  const companyName = String(env.COMPANY_NAME || '').trim();
  const companyAddress = String(env.COMPANY_ADDRESS || '').trim();
  const senderName = String(env.OUTREACH_SENDER_NAME || 'Jose').trim() || 'Jose';

  const problems = [];
  if (!baseUrl) problems.push('BASE_URL');
  else if (!/^https:\/\//i.test(baseUrl) || /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(baseUrl)) {
    problems.push('BASE_URL (debe ser una URL pública que empiece por https://, no localhost)');
  }
  if (!companyName) problems.push('COMPANY_NAME');
  if (!companyAddress) problems.push('COMPANY_ADDRESS (dirección postal: es obligatoria en emails comerciales)');

  if (problems.length && !dryRun) {
    throw new Error(`Configuración incompleta para enviar emails reales. Revisa en tu .env: ${problems.join(', ')}`);
  }
  return {
    baseUrl: baseUrl || 'http://localhost:3001',
    companyName: companyName || '[COMPANY_NAME]',
    companyAddress: companyAddress || '[COMPANY_ADDRESS]',
    senderName,
    warnings: problems,
  };
}

export const formUrl = (config, token) => `${config.baseUrl}/f/${token}`;
export const unsubscribeUrl = (config, token) => `${config.baseUrl}/u/${token}`;
