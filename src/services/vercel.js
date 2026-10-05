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

      const errMsg = out.includes('not valid') ? 'Token de Vercel inválido — crea uno en vercel.com/account/tokens' : (err?.message || `Sin URL en output:\n${out.slice(-300)}`);
      reject(new Error(errMsg));
    });
  });
}
