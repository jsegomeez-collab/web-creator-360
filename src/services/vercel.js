import { exec } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The CLI's launcher is vercel.cmd on Windows and a plain `vercel` script everywhere else (e.g. Render, Linux)
export const vercelBin = (platform = process.platform) => join(__dirname, '../../node_modules/.bin', platform === 'win32' ? 'vercel.cmd' : 'vercel');
const VERCEL_BIN = vercelBin();

export async function deployToVercel(slug, htmlContent) {
  const projectName = slug
    .slice(0, 52)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Temp dir without spaces
  const dir = join(tmpdir(), `wc360${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });

  // Write HTML
  await fs.writeFile(join(dir, 'index.html'), htmlContent, 'utf-8');

  // vercel.json to set project name (--name flag deprecated in CLI v54)
  await fs.writeFile(join(dir, 'vercel.json'), JSON.stringify({ name: projectName }), 'utf-8');

  try {
    const url = await runVercel(dir);
    console.log(`[vercel] Live: ${url}`);
    return url;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// A short, readable reason for a failed deploy. Never includes the command line (it carries the token): the real cause
// is the "Error: …" line of the CLI output, which comes at the END of a long log.
export function vercelFailure(out, err) {
  const clean = String(out || '').replace(/vcp_\w+/g, '***').replace(/--token\s+\S+/g, '--token ***');
  if (/not valid/i.test(clean)) return 'Token de Vercel inválido — crea uno en vercel.com/account/tokens';
  const limit = clean.match(/reached the (\d+) project [A-Za-z]+ limit/i);
  if (limit) return `Vercel: tu cuenta alcanzó el límite de ${limit[1]} proyectos; no se pueden publicar más webs (borra proyectos antiguos o pasa a un plan de pago)`;
  const line = [...clean.matchAll(/^\s*Error:\s*(.+)$/gim)].pop()?.[1];
  if (line) return `Vercel: ${line.trim().slice(0, 300)}`;
  if (err?.killed) return 'Vercel: tardó más de 2 minutos y se canceló';
  return `Vercel: sin dirección en la salida (${clean.trim().split('\n').slice(-3).join(' ').slice(0, 250)})`;
}

function runVercel(cwd) {
  return new Promise((resolve, reject) => {
    const scopeArg = process.env.VERCEL_SCOPE ? `--scope ${process.env.VERCEL_SCOPE}` : '';
    const cmd = [
      `"${VERCEL_BIN}"`,
      '--token', process.env.VERCEL_TOKEN,
      scopeArg,
      '--yes',
      '--prod',
    ].filter(Boolean).join(' ');

    exec(cmd, { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).trim();
      console.log('[vercel] output:', out.slice(-500));

      const urls = out.match(/https:\/\/\S+\.vercel\.app/g);
      if (urls?.length) {
        resolve(urls[urls.length - 1]);
        return;
      }

      reject(new Error(vercelFailure(out, err)));
    });
  });
}

// Deletes a Vercel project by name (the demos use their slug as project name). 404 = already gone = fine.
export async function deleteVercelProject(name, { token = process.env.VERCEL_TOKEN, scope = process.env.VERCEL_SCOPE, fetchImpl = globalThis.fetch } = {}) {
  const h = { Authorization: `Bearer ${String(token).trim()}` };
  let q = '';
  if (scope) {
    const teams = await (await fetchImpl('https://api.vercel.com/v2/teams', { headers: h })).json();
    const team = (teams.teams || []).find(t => t.slug === String(scope).trim());
    if (team) q = `?teamId=${team.id}`;
  }
  const r = await fetchImpl(`https://api.vercel.com/v9/projects/${encodeURIComponent(name)}${q}`, { method: 'DELETE', headers: h });
  if (r.ok || r.status === 404) return true;
  throw new Error(`Vercel no borró ${name} (HTTP ${r.status})`);
}
