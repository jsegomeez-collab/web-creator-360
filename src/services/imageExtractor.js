const UA = 'Mozilla/5.0 (compatible; WebCreator360/1.0; +https://webcreator360.com)';

export async function extractFromWebsite(url) {
  if (!url) return { images: [], brandColor: null, emails: [] };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!res.ok) return { images: [], brandColor: null, emails: [] };
    const html = await res.text();
    const base = new URL(res.url);

    let emails = extractEmails(html);

    // If no email on main page, try common contact pages (one attempt only)
    if (emails.length === 0) {
      emails = await tryContactPage(base);
    }

    return {
      images: extractImages(html, base),
      brandColor: extractBrandColor(html),
      emails,
    };
  } catch {
    return { images: [], brandColor: null, emails: [] };
  }
}

function extractEmails(html) {
  const found = new Map(); // email → score (higher = more reliable source)

  // 1. mailto: links — most reliable, business put these intentionally
  const mailtoRe = /href=["']mailto:([^"'?&#\s]+)/gi;
  let m;
  while ((m = mailtoRe.exec(html)) !== null) {
    const email = m[1].trim().toLowerCase();
    if (isValidEmail(email)) found.set(email, (found.get(email) || 0) + 10);
  }

  // 2. Email pattern anywhere in text/attributes
  const emailRe = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6})\b/g;
  while ((m = emailRe.exec(html)) !== null) {
    const email = m[1].toLowerCase();
    if (isValidEmail(email) && !found.has(email)) {
      found.set(email, 1);
    }
  }

  // Sort by score descending
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([email]) => email);
}

async function tryContactPage(base) {
  const paths = ['/contacto', '/contact', '/contactar', '/sobre-nosotros', '/quienes-somos', '/about'];
  for (const path of paths) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(new URL(path, base).href, {
        signal: controller.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      const emails = extractEmails(html);
      if (emails.length) return emails;
    } catch { /* try next */ }
  }
  return [];
}

function isValidEmail(email) {
  if (!email || email.length > 80) return false;
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6}$/.test(email)) return false;
  if (/noreply|no-reply|donotreply|example\.|@example|@test\.|wordpress|woocommerce|sentry|privacy@|legal@|abuse@/i.test(email)) return false;
  return true;
}

function extractImages(html, base) {
  const found = [];

  // 1. og:image — most reliable hero image
  const og = html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og?.[1]) found.push(resolve(og[1], base));

  // 2. twitter:image
  const tw = html.match(/name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  if (tw?.[1]) found.push(resolve(tw[1], base));

  // 3. img tags with meaningful src
  const imgRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const src = m[1];
    if (!/\.(jpg|jpeg|png|webp)/i.test(src)) continue;
    if (/icon|sprite|pixel|tracking|avatar|thumb|loader|placeholder/i.test(tag)) continue;
    const abs = resolve(src, base);
    if (abs && !found.includes(abs)) found.push(abs);
  }

  // 4. CSS background-image
  const bgRe = /background(?:-image)?:\s*url\(["']?([^"')]+\.(jpg|jpeg|png|webp))["']?\)/gi;
  while ((m = bgRe.exec(html)) !== null) {
    const abs = resolve(m[1], base);
    if (abs && !found.includes(abs)) found.push(abs);
  }

  return found.filter(Boolean).slice(0, 8);
}

function extractBrandColor(html) {
  // theme-color meta tag
  const tc = html.match(/name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/content=["']([^"']+)["'][^>]+name=["']theme-color["']/i);
  if (tc?.[1] && isValidColor(tc[1])) return tc[1].trim();

  // CSS custom property --primary or --brand-color
  const cp = html.match(/--(?:primary|brand|accent|color-primary)[^:]*:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]+\))/);
  if (cp?.[1]) return cp[1];

  return null;
}

function isValidColor(c) {
  return /^#[0-9a-fA-F]{3,6}$/.test(c.trim()) || /^rgba?\(/.test(c.trim());
}

function resolve(src, base) {
  try { return new URL(src, base).href; } catch { return null; }
}
