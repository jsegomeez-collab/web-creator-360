// ─── Auth ─────────────────────────────────────────────────────────────────────
const _token = localStorage.getItem('wc360_token');
let _saasMode = false;

function authHeaders() {
  return _token ? { 'Authorization': `Bearer ${_token}` } : {};
}
function authFetch(url, opts = {}) {
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...authHeaders() } });
}
function logout() {
  localStorage.removeItem('wc360_token');
  localStorage.removeItem('wc360_refresh');
  window.location.href = '/login.html';
}

// Fetch config once on load — hide account sidebar links when running locally
fetch('/api/config').then(r => r.json()).then(cfg => {
  _saasMode = cfg.saasMode;
  const accountNav = document.getElementById('account-nav');
  if (accountNav) accountNav.style.display = _saasMode ? '' : 'none';
}).catch(() => {});

// ─── State ────────────────────────────────────────────────────────────────────
let allBusinesses = [];
let allSites = [];
let pendingSiteId = null;

// ─── UI helpers ───────────────────────────────────────────────────────────────

function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Lucide icon as an SVG string, for markup built in JS ('mail-check' → MailCheck). Empty if the CDN didn't load.
function ic(name, cls = '') {
  const key = name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
  const node = window.lucide?.icons?.[key];
  if (!node) return '';
  const svg = lucide.createElement(node);
  if (cls) svg.setAttribute('class', `${svg.getAttribute('class') || ''} ${cls}`);
  return svg.outerHTML;
}
function refreshIcons() {
  try { window.lucide?.createIcons(); } catch { /* icons are decoration only */ }
}

// Initials on a colour picked from the name, so the same business always gets the same one
const AVATAR_COLORS = ['bg-brand-50 text-brand-700', 'bg-violet-50 text-violet-700', 'bg-sky-50 text-sky-700', 'bg-emerald-50 text-emerald-700', 'bg-amber-50 text-amber-700', 'bg-rose-50 text-rose-700', 'bg-teal-50 text-teal-700', 'bg-fuchsia-50 text-fuchsia-700'];
function avatar(name) {
  const clean = String(name || '?').replace(/\b(llc|inc|corp|co)\b\.?/gi, '').trim();
  const initials = clean.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="avatar ${AVATAR_COLORS[hash % AVATAR_COLORS.length]}">${escHtml(initials)}</span>`;
}
// wide: the name has the row to itself on a phone (the leads table), so it can use more room
const nameCell = (name, sub, wide = false) => `
  <div class="flex min-w-0 items-center gap-3">${avatar(name)}
    <div class="min-w-0"><div class="${wide ? 'max-w-[16rem]' : 'max-w-[8.5rem] sm:max-w-[16rem]'} truncate font-semibold text-slate-800">${escHtml(name || '—')}</div>${sub ? `<div class="mt-0.5 ${wide ? 'max-w-[16rem]' : 'max-w-[8.5rem] sm:max-w-[16rem]'} truncate text-xs text-slate-400">${escHtml(sub)}</div>` : ''}</div>
  </div>`;

// Swaps the button for a spinner + label while it works; returns a function that puts it back
function busy(btn, label) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${ic('loader-circle', 'animate-spin')}<span>${escHtml(label)}</span>`;
  return () => { btn.innerHTML = original; btn.disabled = false; };
}

// ─── Sidebar, drawer and navigation ───────────────────────────────────────────

const navItems = document.querySelectorAll('[data-tab]');

function openDrawer(open) {
  document.body.classList.toggle('sidebar-open', open);
}

function showTab(tab) {
  const btn = document.querySelector(`[data-tab="${tab}"]`);
  if (!btn) return;
  navItems.forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('main > section[id^="tab-"]').forEach(p => p.classList.add('tab-hidden'));
  const panel = document.getElementById('tab-' + tab);
  panel.classList.remove('tab-hidden', 'fade-in');
  void panel.offsetWidth;   // restart the entrance animation
  panel.classList.add('fade-in');

  // Breadcrumb: the group the item sits under + its label
  let group = btn.previousElementSibling;
  while (group && !group.classList.contains('nav-group')) group = group.previousElementSibling;
  document.getElementById('crumb-section').textContent = group?.textContent || '';
  document.getElementById('crumb-page').textContent = btn.querySelector('span')?.textContent || '';

  openDrawer(false);
  window.scrollTo({ top: 0 });
  try { history.replaceState(null, '', '#' + tab); } catch { /* file:// or sandboxed */ }
  loadSection(tab);
}

navItems.forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-goto]');
  if (link) showTab(link.dataset.goto);
});
document.getElementById('menu-btn').addEventListener('click', () => openDrawer(true));
document.getElementById('sidebar-close').addEventListener('click', () => openDrawer(false));
document.getElementById('sidebar-backdrop').addEventListener('click', () => openDrawer(false));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  openDrawer(false);
  if (!document.getElementById('email-modal').classList.contains('hidden')) closeEmailModal();
});

// ─── Toasts ───────────────────────────────────────────────────────────────────

const TOAST_STYLE = {
  success: { icon: 'circle-check', cls: 'border-emerald-100', tile: 'bg-emerald-50 text-emerald-600' },
  error:   { icon: 'circle-x',     cls: 'border-rose-100',    tile: 'bg-rose-50 text-rose-600' },
  info:    { icon: 'info',         cls: 'border-slate-200',   tile: 'bg-brand-50 text-brand-600' },
};

function toast(msg, type = 'success') {
  const style = TOAST_STYLE[type] || TOAST_STYLE.success;
  const el = document.createElement('div');
  el.className = `toast ${style.cls}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `
    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-xl ${style.tile}">${ic(style.icon, 'h-4 w-4')}</span>
    <p class="flex-1 pt-1.5 font-medium leading-snug text-slate-700">${escHtml(msg)}</p>
    <button class="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Cerrar">${ic('x', 'h-4 w-4')}</button>`;
  const stack = document.getElementById('toast-stack');
  stack.appendChild(el);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  const close = () => { el.classList.add('toast-out'); setTimeout(() => el.remove(), 200); };
  el.querySelector('button').addEventListener('click', close);
  setTimeout(close, type === 'error' ? 6000 : 4000);
}

// ─── Confirm dialog (replaces the browser's confirm()) ────────────────────────

function ask({ title, message, confirm: confirmLabel = 'Confirmar', icon = 'triangle-alert', danger = false }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal-box" role="alertdialog" aria-modal="true">
        <div class="flex items-start gap-4">
          <span class="icon-tile ${danger ? 'bg-rose-50 text-rose-600' : 'bg-brand-50 text-brand-600'}">${ic(icon)}</span>
          <div><h2 class="text-base font-semibold text-slate-900">${escHtml(title)}</h2><p class="mt-1.5 text-sm leading-relaxed text-slate-500">${escHtml(message)}</p></div>
        </div>
        <div class="mt-7 flex gap-3">
          <button data-answer="no" class="btn-secondary flex-1">Cancelar</button>
          <button data-answer="yes" class="${danger ? 'btn-danger' : 'btn-primary'} flex-1">${escHtml(confirmLabel)}</button>
        </div>
      </div>`;
    const done = (answer) => {
      document.removeEventListener('keydown', onKey);
      wrap.classList.add('closing');
      setTimeout(() => wrap.remove(), 150);
      resolve(answer);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) return done(false);
      const b = e.target.closest('[data-answer]');
      if (b) done(b.dataset.answer === 'yes');
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-answer="yes"]').focus();
  });
}

// ─── Health ───────────────────────────────────────────────────────────────────
async function checkHealth() {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  try {
    const r = await fetch('/health');
    const d = await r.json();
    const ok = d.status === 'ok';
    dot.className = `pulse-dot ${ok ? 'online' : 'offline'}`;
    txt.textContent = ok ? 'En línea' : 'Error';
  } catch {
    dot.className = 'pulse-dot offline';
    txt.textContent = 'Sin conexión';
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

// Counts up from the number already shown, so refreshes don't restart from zero
function countTo(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  const target = Number(val) || 0;
  const from = Number(el.dataset.value) || 0;
  el.dataset.value = target;
  if (from === target || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = target.toLocaleString('es-ES'); return; }
  const start = performance.now(), ms = 700;
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    el.textContent = Math.round(from + (target - from) * (1 - Math.pow(1 - t, 3))).toLocaleString('es-ES');
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

async function loadStats() {
  try {
    const r = await fetch('/api/dashboard/stats');
    const d = await r.json();

    // Overview cards
    countTo('ov-total', d.businesses.total);
    countTo('ov-pending', d.businesses.prospected);
    countTo('ov-generated', d.sites.total);
    countTo('ov-paid', d.payments.completed);

    // Funnel bars, relative to everything prospected
    const pipe = { 'pipe-prospected': d.businesses.total, 'pipe-scraped': d.businesses.scraped, 'pipe-generated': d.businesses.generated, 'pipe-sent': d.sites.sent, 'pipe-active': d.businesses.active };
    const max = Math.max(1, ...Object.values(pipe).map(n => Number(n) || 0));
    for (const [id, n] of Object.entries(pipe)) {
      countTo(id, n);
      const bar = document.querySelector(`.pipe-bar[data-for="${id}"]`);
      if (bar) bar.style.width = `${Math.max(n ? 2 : 0, ((Number(n) || 0) / max) * 100)}%`;
    }

    // Sidebar counts
    set('count-prospected', d.businesses.total);
    set('count-to-scrape', d.businesses.prospected);
    set('count-to-generate', d.businesses.scraped);
    set('count-to-send', d.sites.preview);
    set('count-paid', d.payments.completed);
  } catch (e) {
    console.error('Stats error:', e);
  }
}

function set(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val ?? '—';
  if (el.classList.contains('nav-count')) el.classList.toggle('opacity-40', !Number(val));
}

function renderGreeting() {
  const h = new Date().getHours();
  const hello = h < 6 ? 'Buenas noches' : h < 13 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
  const today = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('greeting').textContent = `${hello} · ${today}`;
}

// ─── Data loaders ─────────────────────────────────────────────────────────────
async function fetchAll() {
  const [bRes, sRes] = await Promise.all([
    fetch('/api/dashboard/businesses'),
    fetch('/api/dashboard/sites'),
  ]);
  allBusinesses = await bRes.json();
  allSites = await sRes.json();
}

// Placeholder rows the first time a tab's tables are shown
function showSkeleton(tab) {
  document.querySelectorAll(`#tab-${tab} tbody`).forEach(tbody => {
    if (tbody.children.length) return;
    const cols = tbody.closest('table').querySelectorAll('thead th');
    tbody.innerHTML = Array.from({ length: 4 }, () => `<tr>${[...cols].map((th, i) =>
      `<td class="${th.className}">${i === 0 ? '<div class="flex items-center gap-3"><div class="skeleton h-9 w-9 rounded-xl"></div><div class="flex-1 space-y-2"><div class="skeleton h-3 w-32"></div><div class="skeleton h-2.5 w-20"></div></div></div>' : '<div class="skeleton h-3 w-16"></div>'}</td>`).join('')}</tr>`).join('');
  });
}

async function loadSection(tab) {
  showSkeleton(tab);
  if (tab.startsWith('leads-')) return loadLeadsSection(tab);   // pipeline "LLCs nuevas" (leads.js)
  if (tab === 'overview' && typeof renderOverviewCampaign === 'function') renderOverviewCampaign();
  await fetchAll();
  if (tab === 'overview' || tab === 'prospecting') renderProspecting();
  if (tab === 'scraping') renderScraping();
  if (tab === 'generation') renderGeneration();
  if (tab === 'outreach') renderOutreach();
  if (tab === 'followup') renderFollowup();
  if (tab === 'payments') renderPayments();
  loadStats();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function badge(status) {
  const labels = { prospected: 'Prospectado', scraped: 'Analizado', generated: 'Web creada', sent: 'Enviado', active: 'Activo', expired: 'Caducada', preview: 'En prueba', completed: 'Completado', pending: 'Pendiente' };
  return `<span class="badge badge-${escHtml(status)}">${escHtml(labels[status] || status)}</span>`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

// `icon` is a Lucide name ('inbox', 'users'…)
function emptyRow(cols, msg, icon = 'inbox') {
  return `<tr><td colspan="${cols}"><div class="empty-state"><div class="empty-icon">${ic(icon) || ic('inbox')}</div><p class="empty-title">${escHtml(msg)}</p></div></td></tr>`;
}

const linkOut = (url, label = 'Abrir') => url
  ? `<a href="${escHtml(url)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700 hover:underline">${escHtml(label)}${ic('arrow-up-right', 'h-3.5 w-3.5')}</a>`
  : '<span class="text-xs text-slate-300">—</span>';
const rating = (r) => r ? `<span class="inline-flex items-center gap-1 font-semibold text-slate-700">${ic('star', 'h-3.5 w-3.5 fill-amber-400 text-amber-400')}${escHtml(r)}</span>` : '<span class="text-slate-300">—</span>';
const muted = (v) => v ? `<span class="text-[13px] text-slate-500">${escHtml(v)}</span>` : '<span class="text-slate-300">—</span>';

// ─── Renders ─────────────────────────────────────────────────────────────────

function renderProspecting(filter = '') {
  const tbody = document.getElementById('all-businesses-table');
  const q = filter.toLowerCase();
  const list = q
    ? allBusinesses.filter(b => b.name.toLowerCase().includes(q) || (b.category||'').toLowerCase().includes(q))
    : allBusinesses;

  const count = document.getElementById('prospect-count');
  if (count) count.textContent = list.length.toLocaleString('es-ES');

  if (!list.length) {
    tbody.innerHTML = emptyRow(5, filter ? 'Sin resultados para esa búsqueda.' : 'Aún no hay negocios. Lanza tu primera prospección arriba.', filter ? 'search-x' : 'radar');
    return;
  }
  tbody.innerHTML = list.map(b => `
    <tr class="table-row">
      <td>${nameCell(b.name, b.address)}</td>
      <td class="hidden md:table-cell">${muted(b.category)}</td>
      <td class="hidden lg:table-cell">
        <div class="flex flex-col gap-0.5">${b.website ? linkOut(b.website, 'Su web') : ''}${b.phone ? `<span class="text-xs text-slate-400">${escHtml(b.phone)}</span>` : ''}${!b.website && !b.phone ? '<span class="text-slate-300">—</span>' : ''}</div>
      </td>
      <td class="hidden sm:table-cell">${rating(b.rating)}</td>
      <td>${badge(b.status)}</td>
    </tr>`).join('');
}

function filterProspecting() {
  const q = document.getElementById('prospect-search')?.value || '';
  renderProspecting(q);
}

function renderScraping(filter = '') {
  const pending = allBusinesses.filter(b => b.status === 'prospected');
  const done = allBusinesses.filter(b => ['scraped', 'generated', 'active'].includes(b.status));

  // Pending table
  const tbody = document.getElementById('scraping-table');
  const pendingCount = document.getElementById('scrape-pending-count');
  if (pendingCount) pendingCount.textContent = pending.length.toLocaleString('es-ES');

  tbody.innerHTML = pending.length
    ? pending.map(b => `
      <tr class="table-row">
        <td>${nameCell(b.name, b.address)}</td>
        <td class="hidden md:table-cell">${muted(b.category)}</td>
        <td class="hidden lg:table-cell">${b.website ? linkOut(b.website, 'Ver web') : '<span class="text-xs text-slate-400">Sin web</span>'}</td>
        <td class="hidden sm:table-cell">${rating(b.rating)}</td>
        <td class="text-right">
          <button class="action-btn btn-scrape" onclick="scrapeOne('${escHtml(b.id)}', this)">${ic('scan-search')}Analizar</button>
        </td>
      </tr>`).join('')
    : emptyRow(5, 'No queda ningún negocio por analizar. ¡Bien hecho!', 'circle-check');

  // Done table (with search filter)
  renderScrapedDone(done, filter);
}

function renderScrapedDone(done, filter = '') {
  const q = filter.toLowerCase();
  const list = q ? done.filter(b => b.name.toLowerCase().includes(q) || (b.email||'').toLowerCase().includes(q)) : done;

  const doneCount = document.getElementById('scraped-done-count');
  if (doneCount) doneCount.textContent = list.length.toLocaleString('es-ES');

  const tbody = document.getElementById('scraped-done-table');
  tbody.innerHTML = list.length
    ? list.map(b => `
      <tr class="table-row" id="scraped-row-${escHtml(b.id)}">
        <td>${nameCell(b.name, b.address)}</td>
        <td class="hidden lg:table-cell">${muted(b.category)}</td>
        <td class="hidden md:table-cell">
          ${b.email
            ? `<a href="mailto:${escHtml(b.email)}" class="inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-700 hover:text-brand-600">${ic('mail', 'h-3.5 w-3.5 text-emerald-500')}${escHtml(b.email)}</a>`
            : `<span class="inline-flex items-center gap-1.5 text-xs text-rose-500">${ic('mail-x', 'h-3.5 w-3.5')}Sin email</span>`}
        </td>
        <td class="hidden lg:table-cell">
          ${b.phone
            ? `<a href="tel:${escHtml(b.phone)}" class="inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-700 hover:text-brand-600">${ic('phone', 'h-3.5 w-3.5 text-emerald-500')}${escHtml(b.phone)}</a>`
            : '<span class="text-xs text-rose-500">Sin teléfono</span>'}
        </td>
        <td class="hidden sm:table-cell">${badge(b.status)}</td>
        <td class="text-right">
          <button class="action-btn btn-scrape" onclick="rescrapeOne('${escHtml(b.id)}', this)" title="Volver a analizar para actualizar teléfono y datos">${ic('refresh-cw')}Repetir</button>
        </td>
      </tr>`).join('')
    : emptyRow(6, q ? 'Sin resultados para esa búsqueda.' : 'Todavía no has analizado ningún negocio.', q ? 'search-x' : 'scan-search');
}

function filterScraped() {
  const q = document.getElementById('scraped-search')?.value || '';
  const done = allBusinesses.filter(b => ['scraped', 'generated', 'active'].includes(b.status));
  renderScrapedDone(done, q);
}

function renderGeneration() {
  const pending = allBusinesses.filter(b => b.status === 'scraped');
  const tbody = document.getElementById('generation-table');
  if (!pending.length) {
    tbody.innerHTML = emptyRow(4, 'No hay negocios analizados esperando su web.', 'wand-sparkles');
  } else {
    tbody.innerHTML = pending.map(b => `
      <tr class="table-row">
        <td>${nameCell(b.name)}</td>
        <td class="hidden sm:table-cell">${muted(b.category)}</td>
        <td class="hidden md:table-cell">${muted(b.address)}</td>
        <td class="text-right">
          <button class="action-btn btn-generate" onclick="generateOne('${escHtml(b.id)}', this)">${ic('sparkles')}Generar web</button>
        </td>
      </tr>`).join('');
  }

  // Sites generated
  const sitesBody = document.getElementById('sites-table');
  if (!allSites.length) {
    sitesBody.innerHTML = emptyRow(6, 'Aún no hay webs generadas.', 'globe');
  } else {
    sitesBody.innerHTML = allSites.map(s => `
      <tr class="table-row" id="site-row-${escHtml(s.id)}">
        <td>${nameCell(s.businesses?.name)}</td>
        <td class="hidden lg:table-cell"><code class="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">${escHtml(s.slug)}</code></td>
        <td class="hidden sm:table-cell">${badge(s.status)}</td>
        <td class="hidden md:table-cell text-[13px] text-slate-500">${fmtDate(s.expires_at)}</td>
        <td class="hidden sm:table-cell" data-preview>${s.preview_url ? `<a href="${escHtml(s.preview_url)}" target="_blank" rel="noopener" class="action-btn btn-preview">${ic('external-link')}Ver</a>` : '<span class="text-xs text-slate-400">Pendiente</span>'}</td>
        <td class="text-right">
          <div class="inline-flex flex-wrap justify-end gap-1.5">
            <span class="sm:hidden" data-preview>${s.preview_url ? `<a href="${escHtml(s.preview_url)}" target="_blank" rel="noopener" class="action-btn btn-preview">${ic('external-link')}Ver</a>` : ''}</span>
            <button class="action-btn btn-generate" id="regen-btn-${escHtml(s.id)}" onclick="regenerateOne('${escHtml(s.id)}', this)" title="Regenerar con el tema Halo" aria-label="Regenerar con el tema Halo">${ic('wand-sparkles')}<span class="hidden sm:inline">Halo</span></button>
            <button class="action-btn btn-send" id="redeploy-btn-${escHtml(s.id)}" onclick="redeployOne('${escHtml(s.id)}', this)" title="Volver a publicar" aria-label="Volver a publicar">${ic('cloud-upload')}<span class="hidden sm:inline">Publicar</span></button>
          </div>
        </td>
      </tr>`).join('');
  }
}

function renderOutreach() {
  const toSend = allSites.filter(s => s.status === 'preview');
  const tbody = document.getElementById('outreach-table');

  const readyCount = toSend.filter(s => s.scraped_email).length;
  const countEl = document.getElementById('bulk-ready-count');
  if (countEl) countEl.textContent = readyCount;

  if (!toSend.length) {
    tbody.innerHTML = emptyRow(4, 'No hay webs listas para enviar. Genera webs primero.', 'mail');
    return;
  }
  tbody.innerHTML = toSend.map(s => {
    const email = s.scraped_email;
    const emailCell = email
      ? `<span class="inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-700">${ic('mail', 'h-3.5 w-3.5 text-emerald-500')}${escHtml(email)}</span>`
      : `<span class="text-xs text-slate-400">Sin email</span>`;

    const sendBtn = email
      ? `<button class="action-btn btn-send" onclick="sendDirect('${escHtml(s.id)}', this)">${ic('send')}Enviar</button>`
      : `<button class="action-btn btn-secondary" onclick="openEmailModal('${escHtml(s.id)}')">${ic('plus')}Añadir email</button>`;

    return `
    <tr class="table-row" id="outreach-row-${escHtml(s.id)}">
      <td>${nameCell(s.businesses?.name, s.businesses?.category)}</td>
      <td class="hidden md:table-cell">${emailCell}</td>
      <td class="hidden sm:table-cell">${linkOut(s.preview_url, 'Ver web')}</td>
      <td class="text-right">${sendBtn}</td>
    </tr>`;
  }).join('');
}

async function sendDirect(siteId, btn) {
  const restore = busy(btn, 'Enviando…');
  try {
    const r = await fetch(`/api/outreach/${siteId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (d.success) {
      toast(`Enviado a ${d.email}`);
      const row = document.getElementById(`outreach-row-${siteId}`);
      if (row) row.remove();
    } else {
      toast('Error: ' + d.error, 'error');
      restore();
    }
  } catch (e) {
    toast('Error de red', 'error');
    restore();
  }
}

async function renderFollowup() {
  const res = await fetch('/api/dashboard/outreach');
  const rows = await res.json();
  const tbody = document.getElementById('followup-table');
  if (!rows.length) {
    tbody.innerHTML = emptyRow(5, 'Todavía no has enviado ningún email.', 'repeat');
    return;
  }
  tbody.innerHTML = rows.map(o => `
    <tr class="table-row">
      <td>${nameCell(o.businesses?.name)}</td>
      <td class="hidden md:table-cell">${muted(o.contact)}</td>
      <td><span class="badge badge-${o.follow_up_number === 0 ? 'generated' : 'sent'}">${o.follow_up_number === 0 ? 'Inicial' : `Recordatorio ${escHtml(o.follow_up_number)}`}</span></td>
      <td class="hidden lg:table-cell text-[13px] text-slate-500">${o.next_follow_up_at ? fmtDate(o.next_follow_up_at) : '<span class="text-slate-300">—</span>'}</td>
      <td class="hidden sm:table-cell text-[13px] text-slate-500">${fmtDate(o.sent_at)}</td>
    </tr>`).join('');
}

async function renderPayments() {
  const res = await fetch('/api/dashboard/payments');
  const rows = await res.json();
  const tbody = document.getElementById('payments-table');
  if (!rows.length) {
    tbody.innerHTML = emptyRow(5, 'Todavía no hay pagos. Llegarán aquí en cuanto un cliente pague.', 'credit-card');
    return;
  }
  tbody.innerHTML = rows.map(p => `
    <tr class="table-row">
      <td>${nameCell(p.businesses?.name)}</td>
      <td class="font-semibold tabular-nums text-emerald-600">${p.amount ? `€${(p.amount / 100).toFixed(2)}` : '—'}</td>
      <td class="hidden sm:table-cell">${badge(p.status)}</td>
      <td class="hidden md:table-cell">${linkOut(p.generated_sites?.preview_url, 'Ver web')}</td>
      <td class="hidden sm:table-cell text-[13px] text-slate-500">${fmtDate(p.created_at)}</td>
    </tr>`).join('');
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function scrapeOne(id, btn) {
  const restore = busy(btn, 'Analizando…');
  try {
    const r = await fetch(`/api/scrape/${id}`, { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      toast('Negocio analizado');
      await loadSection('scraping');
    } else {
      toast('Error: ' + d.error, 'error');
      restore();
    }
  } catch (e) {
    toast('Error de red', 'error');
    restore();
  }
}

async function rescrapeOne(id, btn) {
  const restore = busy(btn, 'Analizando…');
  try {
    const r = await fetch(`/api/scrape/${id}`, { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      toast('Datos actualizados');
      await fetchAll();
      const done = allBusinesses.filter(b => ['scraped','generated','active'].includes(b.status));
      renderScrapedDone(done, document.getElementById('scraped-search')?.value || '');
    } else {
      toast('Error: ' + d.error, 'error');
      restore();
    }
  } catch (e) {
    toast('Error de red', 'error');
    restore();
  }
}

async function scrapeAll() {
  const pending = allBusinesses.filter(b => b.status === 'prospected');
  if (!pending.length) { toast('No hay negocios pendientes', 'info'); return; }

  const btn = document.getElementById('scrape-all-btn');
  const restore = busy(btn, `Analizando 0/${pending.length}…`);
  const label = btn.querySelector('span');

  for (let i = 0; i < pending.length; i++) {
    label.textContent = `Analizando ${i + 1}/${pending.length}…`;
    try {
      await fetch(`/api/scrape/${pending[i].id}`, { method: 'POST' });
    } catch {}
  }

  toast(`${pending.length} negocios analizados`);
  restore();
  await loadSection('scraping');
}

async function generateOne(id, btn) {
  const restore = busy(btn, 'Generando…');
  try {
    const r = await fetch(`/api/generate/${id}`, { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      toast('Web generada');
      await loadSection('generation');
    } else {
      toast('Error: ' + d.error, 'error');
      restore();
    }
  } catch (e) {
    toast('Error de red', 'error');
    restore();
  }
}

async function generateAll() {
  const pending = allBusinesses.filter(b => b.status === 'scraped');
  if (!pending.length) { toast('No hay negocios pendientes', 'info'); return; }

  const btn = document.getElementById('generate-all-btn');
  const restore = busy(btn, `Generando 0/${pending.length}…`);
  const label = btn.querySelector('span');

  for (let i = 0; i < pending.length; i++) {
    label.textContent = `Generando ${i + 1}/${pending.length}…`;
    try {
      await fetch(`/api/generate/${pending[i].id}`, { method: 'POST' });
    } catch {}
  }

  toast(`${pending.length} webs generadas`);
  restore();
  await loadSection('generation');
}

// ─── Email Modal ──────────────────────────────────────────────────────────────

function openEmailModal(siteId) {
  pendingSiteId = siteId;
  document.getElementById('email-modal').classList.remove('hidden');
  document.getElementById('modal-email').value = '';
  document.getElementById('modal-email').focus();
}

function closeEmailModal() {
  document.getElementById('email-modal').classList.add('hidden');
  pendingSiteId = null;
}

document.getElementById('modal-cancel').addEventListener('click', closeEmailModal);

document.getElementById('email-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('email-modal')) closeEmailModal();
});

document.getElementById('modal-email').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('modal-send').click();
});

document.getElementById('modal-send').addEventListener('click', async () => {
  const email = document.getElementById('modal-email').value.trim();
  if (!email || !pendingSiteId) return;

  const btn = document.getElementById('modal-send');
  const restore = busy(btn, 'Enviando…');

  try {
    const r = await fetch(`/api/outreach/${pendingSiteId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const d = await r.json();

    if (d.success) {
      document.getElementById('email-modal').classList.add('hidden');
      toast('Email enviado a ' + d.contact);
      await loadSection('outreach');
    } else {
      toast('Error: ' + d.error, 'error');
    }
  } catch {
    toast('Error de red', 'error');
  } finally {
    restore();
    pendingSiteId = null;
  }
});

// ─── Prospect Form ────────────────────────────────────────────────────────────

document.getElementById('prospect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const zone = document.getElementById('prospect-zone').value.trim();
  const category = document.getElementById('prospect-category').value.trim();
  const result = document.getElementById('prospect-result');
  const btn = e.target.querySelector('button[type="submit"]');

  const restore = busy(btn, 'Buscando…');
  result.textContent = '';

  try {
    const r = await fetch('/api/prospect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone, category }),
    });
    const d = await r.json();
    if (d.error) {
      result.textContent = d.error;
      toast(d.error, 'error');
    } else {
      result.textContent = `${d.inserted} nuevos de ${d.total_found} encontrados.`;
      toast(`${d.inserted} negocios añadidos`);
      await loadSection('prospecting');
    }
  } catch {
    toast('Error de red', 'error');
  } finally {
    restore();
  }
});

// ─── Regenerate ───────────────────────────────────────────────────────────────

async function regenerateOne(siteId, btn) {
  const restore = busy(btn, 'Generando…');

  try {
    const r = await fetch(`/api/regenerate/${siteId}`, { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      toast('Regenerada y publicada');
      await loadSection('generation');
    } else {
      toast('Error: ' + d.error, 'error');
      restore();
    }
  } catch {
    toast('Error de red', 'error');
    restore();
  }
}

async function redeployOne(siteId, btn) {
  const restore = busy(btn, 'Publicando…');

  try {
    const r = await fetch(`/api/generate/redeploy/${siteId}`, { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      toast(`Publicada: ${d.preview_url}`);
      // Update the preview link in the row without full reload
      const link = `<a href="${escHtml(d.preview_url)}" target="_blank" rel="noopener" class="action-btn btn-preview">${ic('external-link')}Ver</a>`;
      document.querySelectorAll(`#site-row-${CSS.escape(siteId)} [data-preview]`).forEach(cell => { cell.innerHTML = link; });
    } else {
      toast('Error: ' + d.error, 'error');
    }
  } catch {
    toast('Error de red', 'error');
  } finally {
    restore();
  }
}

const logLine = (cls, icon, html) => `<div class="flex items-start gap-2 ${cls}">${ic(icon, 'mt-0.5 h-3.5 w-3.5 shrink-0')}<span class="min-w-0 break-words">${html}</span></div>`;
const LOG_STYLE = { ok: ['text-emerald-400', 'check'], error: ['text-rose-400', 'x'], skipped: ['text-slate-500', 'minus'] };

async function regenerateAll() {
  const btn = document.getElementById('regenerate-all-btn');
  const restore = busy(btn, 'Iniciando…');

  // Progress modal
  const progress = document.createElement('div');
  progress.id = 'regen-progress';
  progress.className = 'modal-backdrop';
  progress.innerHTML = `
    <div class="modal-box !max-w-lg">
      <div class="flex items-start gap-4">
        <span class="icon-tile bg-violet-50 text-violet-600">${ic('wand-sparkles')}</span>
        <div><h2 class="text-base font-semibold text-slate-900">Regenerando con el tema Halo</h2><p class="mt-1 text-[13px] text-slate-500">Claude escribe cada web y se vuelve a publicar. No cierres esta pestaña.</p></div>
      </div>
      <div id="regen-log" class="console mt-5 h-56 rounded-xl"></div>
      <p id="regen-summary" class="mt-3 text-[13px] font-medium text-slate-600"></p>
    </div>`;
  document.body.appendChild(progress);

  const log = document.getElementById('regen-log');
  const summary = document.getElementById('regen-summary');

  try {
    const res = await fetch('/api/regenerate/batch/all', { method: 'POST' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value).split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d.done) {
            summary.textContent = `Completado: ${d.ok} correctas y ${d.failed} con error, de ${d.total} webs.`;
            toast(`${d.ok} webs regeneradas y publicadas`);
          } else {
            const [cls, icon] = LOG_STYLE[d.status] || LOG_STYLE.skipped;
            log.innerHTML += logLine(cls, icon, `${escHtml(d.slug)}${d.status === 'ok' ? '' : ' — ' + escHtml(d.reason || '')}`);
            log.scrollTop = log.scrollHeight;
          }
        } catch {}
      }
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }

  restore();

  setTimeout(() => {
    progress.classList.add('closing');
    setTimeout(() => progress.remove(), 150);
    loadSection('generation');
    loadStats();
  }, 4000);
}

// ─── Auto Pipeline ────────────────────────────────────────────────────────────
async function runPipeline() {
  const btn = document.getElementById('run-pipeline-btn');
  const logBox = document.getElementById('pipeline-log');
  const entries = document.getElementById('pipeline-log-entries');
  const badge = document.getElementById('pipeline-status-badge');

  const restore = busy(btn, 'Ejecutando…');
  logBox.classList.remove('hidden');
  entries.innerHTML = '';
  badge.className = 'badge badge-blue';
  badge.textContent = 'Ejecutando…';

  const stageLabel = { scrape: 'Análisis', generate: 'Web', outreach: 'Email' };

  try {
    const res = await fetch('/api/pipeline/run', { method: 'POST' });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);

          if (d.status === 'done') {
            badge.className = 'badge badge-green';
            badge.textContent = 'Completado';
            entries.innerHTML += `<div class="mt-3 border-t border-white/10 pt-3 font-semibold text-slate-100">
              Analizados: ${escHtml(d.scraped)} · Webs: ${escHtml(d.generated)} · Emails: ${escHtml(d.sent)} · Sin email: ${escHtml(d.skipped_no_email)} · Errores: ${escHtml(d.errors)}
            </div>`;
            loadStats();
          } else if (d.status === 'skipped') {
            badge.className = 'badge badge-blue';
            badge.textContent = 'Ya en ejecución';
          } else if (d.status === 'error') {
            badge.className = 'badge badge-red';
            badge.textContent = 'Error';
            entries.innerHTML += logLine('text-rose-400', 'x', escHtml(d.message));
          } else if (d.stage) {
            const [cls, icon] = LOG_STYLE[d.status] || ['text-slate-400', 'dot'];
            const label = stageLabel[d.stage] || d.stage;
            const detail = d.email ? ` → ${d.email}` : d.preview_url ? ` → ${d.preview_url}` : d.reason ? ` — ${d.reason}` : '';
            entries.innerHTML += logLine(cls, icon, `<span class="text-slate-500">[${escHtml(label)}]</span> ${escHtml(d.name || '')}${escHtml(detail)}`);
            entries.scrollTop = entries.scrollHeight;
          }
        } catch {}
      }
    }
  } catch (e) {
    badge.className = 'badge badge-red';
    badge.textContent = 'Error';
    entries.innerHTML += logLine('text-rose-400', 'x', escHtml(e.message));
  }

  restore();
}

// ─── Bulk Send ────────────────────────────────────────────────────────────────
async function sendAll() {
  const ready = allSites.filter(s => s.status === 'preview' && s.scraped_email);
  if (!ready.length) { toast('No hay negocios con email para enviar', 'error'); return; }

  const n = ready.length;
  const confirmed = await ask({
    title: `¿Enviar ${n} email${n > 1 ? 's' : ''}?`,
    message: `Cada negocio con email recibirá su propuesta con el enlace a su web. No se puede deshacer.`,
    confirm: `Enviar ${n}`, icon: 'send',
  });
  if (!confirmed) return;

  const btn = document.getElementById('send-all-btn');
  const logBox = document.getElementById('bulk-log');
  const entries = document.getElementById('bulk-log-entries');
  const statusBadge = document.getElementById('bulk-status-badge');

  const restore = busy(btn, 'Enviando…');
  logBox.classList.remove('hidden');
  entries.innerHTML = '';
  statusBadge.className = 'badge badge-blue';
  statusBadge.textContent = 'Enviando…';

  try {
    const res = await fetch('/api/outreach/batch', { method: 'POST' });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.status === 'start') {
            entries.innerHTML += logLine('text-slate-400', 'loader', `Procesando ${escHtml(d.total)} negocio${d.total !== 1 ? 's' : ''}…`);
          } else if (d.status === 'ok') {
            entries.innerHTML += logLine('text-emerald-400', 'check', `${escHtml(d.name)} — ${escHtml(d.email)}`);
            entries.scrollTop = entries.scrollHeight;
          } else if (d.status === 'skipped') {
            entries.innerHTML += logLine('text-slate-500', 'minus', `${escHtml(d.slug)} — ${escHtml(d.reason)}`);
            entries.scrollTop = entries.scrollHeight;
          } else if (d.status === 'error') {
            entries.innerHTML += logLine('text-rose-400', 'x', `${escHtml(d.slug)} — ${escHtml(d.reason)}`);
            entries.scrollTop = entries.scrollHeight;
          } else if (d.status === 'done') {
            statusBadge.className = 'badge badge-green';
            statusBadge.textContent = 'Completado';
            entries.innerHTML += `<div class="mt-3 border-t border-white/10 pt-3 font-semibold text-slate-100">
              Enviados: ${escHtml(d.sent)} · Omitidos: ${escHtml(d.skipped)} · Errores: ${escHtml(d.errors)}
            </div>`;
            toast(`${d.sent} email${d.sent !== 1 ? 's' : ''} enviado${d.sent !== 1 ? 's' : ''}`);
            loadStats();
            await fetchAll();
            renderOutreach();
          }
        } catch {}
      }
    }
  } catch (e) {
    statusBadge.className = 'badge badge-red';
    statusBadge.textContent = 'Error';
    entries.innerHTML += logLine('text-rose-400', 'x', escHtml(e.message));
    toast('Error: ' + e.message, 'error');
  }

  restore();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
refreshIcons();
renderGreeting();
checkHealth();
setInterval(checkHealth, 60_000);
loadStats();
// After leads.js has loaded too. Opens the tab in the URL (#leads-send…) so a bookmark or a refresh lands where you were.
document.addEventListener('DOMContentLoaded', () => {
  const start = location.hash.slice(1);
  if (start && start !== 'overview' && document.querySelector(`[data-tab="${start}"]`)) showTab(start);
  else loadSection('overview');
});
