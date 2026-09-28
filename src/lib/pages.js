// Tiny HTML page helpers for the public pages (the lead's page to ask for the call). Mobile-first, Halo-theme look.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function page(title, body, { lang = 'es' } = {}) {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:#050814;color:#F0F4FF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif}
  .card{width:100%;max-width:440px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:30px}
  h1{margin:0 0 10px;font-size:24px;line-height:1.25}
  p{margin:0 0 18px;color:#94A3B8;line-height:1.6;font-size:15px}
  p strong{color:#F0F4FF}
  label{display:block;margin:0 0 6px;font-size:13px;font-weight:600;color:#CBD5E1}
  input[type=text],input[type=tel],select{width:100%;padding:12px 14px;margin-bottom:16px;border-radius:9px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:#F0F4FF;font-size:16px}
  select option{color:#111}
  .check{display:flex;gap:10px;align-items:flex-start;margin:4px 0 18px;font-size:13px;color:#94A3B8;line-height:1.5}
  .check input{margin-top:3px;width:18px;height:18px;flex-shrink:0}
  button,.btn{display:block;width:100%;padding:14px;border:0;border-radius:10px;background:#6366F1;color:#fff;font-size:16px;font-weight:700;cursor:pointer;text-align:center;text-decoration:none}
  button:disabled{opacity:.6;cursor:default}
  .err{color:#FCA5A5;font-size:14px;margin:0 0 14px}
  .hp{position:absolute;left:-9999px;height:0;overflow:hidden}
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

// Private, never cached, never indexed
export function sendPage(res, status, html) {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  }).send(html);
}

export const notFoundPage = (res) =>
  sendPage(res, 404, page('Enlace no encontrado', '<h1>Enlace no encontrado</h1><p>Este enlace no existe o ya no está disponible.</p>'));
