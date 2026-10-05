// Locks the whole app behind one shared username/password (HTTP Basic Auth) when DASHBOARD_USER/DASHBOARD_PASSWORD are
// set — this app has no per-route login of its own (see routes/leads.js and friends), so once it's reachable from the
// internet, this is the only thing standing between "anyone with the URL" and your real business data.
// Without those two env vars set, this does nothing (so local development stays exactly as it was).
import { timingSafeEqual } from 'crypto';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// Paths that can never go through a login prompt: Render's own health check, Stripe calling its webhooks directly
// (both already have their own protection: Render doesn't need one, Stripe's webhooks verify a signature), and the
// customer-facing pages below.
const OPEN_PATHS = new Set(['/health', '/webhooks/stripe', '/api/billing/webhook', '/payment/success']);
// What the businesses you contact open themselves: their demo site (the emails link it when Vercel isn't used) and the
// Stripe checkout it leads to. They carry no dashboard data, and a password prompt there would lose the sale.
// Exactly one plain segment (a slug or a site id): nothing like "/preview/../api/…" gets through.
const OPEN_PAGE_RE = /^\/(preview|checkout)\/[A-Za-z0-9_-]+$/;

export const isOpenPath = (path) => OPEN_PATHS.has(path) || OPEN_PAGE_RE.test(path);

export function dashboardAuth(req, res, next) {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!user || !pass) return next();
  if (isOpenPath(req.path)) return next();

  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep >= 0 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), pass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Web Creator 360", charset="UTF-8"').status(401).send('Autenticación requerida');
}
