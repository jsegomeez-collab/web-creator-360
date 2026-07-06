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

// ─── Navigation ───────────────────────────────────────────────────────────────
const navItems = document.querySelectorAll('[data-tab]');
navItems.forEach(btn => {
  btn.addEventListener('click', () => {
    navItems.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('[id^="tab-"]').forEach(p => p.classList.add('tab-hidden'));
    document.getElementById('tab-' + btn.dataset.tab).classList.remove('tab-hidden');
    loadSection(btn.dataset.tab);
  });
});

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  document.getElementById('toast-icon').textContent = type === 'success' ? '✓' : '✕';
  el.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ─── Health ───────────────────────────────────────────────────────────────────
async function checkHealth() {
  try {
    const r = await fetch('/health');
    const d = await r.json();
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    if (d.status === 'ok') {
      dot.className = 'pulse-dot online';
      txt.textContent = 'Online';
    } else {
      dot.className = 'pulse-dot offline';
      txt.textContent = 'Error';
    }
  } catch {
    document.getElementById('status-dot').className = 'pulse-dot offline';
    document.getElementById('status-text').textContent = 'Sin conexión';
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const r = await fetch('/api/dashboard/stats');
    const d = await r.json();

    // Overview cards
    set('ov-total', d.businesses.total);
    set('ov-pending', d.businesses.prospected);
    set('ov-generated', d.sites.total);
    set('ov-paid', d.payments.completed);

    // Pipeline row
    set('pipe-prospected', d.businesses.total);
    set('pipe-scraped', d.businesses.scraped);
    set('pipe-generated', d.businesses.generated);
    set('pipe-sent', d.sites.sent);
    set('pipe-active', d.businesses.active);

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
  if (el) el.textContent = val ?? '—';
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

async function loadSection(tab) {
  await fetchAll();
  if (tab === 'overview' || tab === 'prospecting') renderProspecting();
  if (tab === 'scraping') renderScraping();
  if (tab === 'generation') renderGeneration();
  if (tab === 'outreach') renderOutreach();
  if (tab === 'whatsapp') renderWhatsApp();
  if (tab === 'followup') renderFollowup();
  if (tab === 'payments') renderPayments();
  loadStats();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function badge(status) {
  const labels = { prospected: 'Prospectado', scraped: 'Scrapeado', generated: 'Generado', sent: 'Enviado', active: 'Activo', expired: 'Expirado', preview: 'Preview', completed: 'Completado', pending: 'Pendiente' };
  return `<span class="badge badge-${status}">${labels[status] || status}</span>`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

function emptyRow(cols, msg, icon = '◈') {
  return `<tr><td colspan="${cols}"><div class="empty-state"><div class="empty-icon">${icon}</div><p class="text-slate-400 text-sm font-medium">${msg}</p></div></td></tr>`;
}

// ─── Renders ─────────────────────────────────────────────────────────────────

function renderProspecting(filter = '') {
  const tbody = document.getElementById('all-businesses-table');
  const q = filter.toLowerCase();
  const list = q
    ? allBusinesses.filter(b => b.name.toLowerCase().includes(q) || (b.category||'').toLowerCase().includes(q))
    : allBusinesses;

  const count = document.getElementById('prospect-count');
  if (count) count.textContent = `(${list.length})`;

  if (!list.length) {
    tbody.innerHTML = emptyRow(5, filter ? 'Sin resultados para esa búsqueda.' : 'Sin negocios aún. Lanza tu primera prospección.', '⊕');
    return;
  }
  tbody.innerHTML = list.map(b => `
    <tr class="table-row">
      <td class="px-6 py-4">
        <div class="font-medium text-slate-800">${b.name}</div>
        <div class="text-xs text-slate-400 mt-0.5">${b.address || ''}</div>
      </td>
      <td class="px-6 py-4 text-slate-500 text-xs">${b.category || '—'}</td>
      <td class="px-6 py-4">
        ${b.website ? `<a href="${b.website}" target="_blank" class="text-xs text-blue-500 hover:underline block truncate max-w-[180px]">🌐 Web →</a>` : ''}
        ${b.phone ? `<span class="text-xs text-slate-400">${b.phone}</span>` : ''}
      </td>
      <td class="px-6 py-4">${b.rating ? `<span class="text-amber-500 font-medium">★ ${b.rating}</span>` : '—'}</td>
      <td class="px-6 py-4">${badge(b.status)}</td>
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
  if (pendingCount) pendingCount.textContent = `(${pending.length})`;

  tbody.innerHTML = pending.length
    ? pending.map(b => `
      <tr class="table-row">
        <td class="px-6 py-4">
          <div class="font-medium text-slate-800">${b.name}</div>
          <div class="text-xs text-slate-400 mt-0.5">${b.address || ''}</div>
        </td>
        <td class="px-6 py-4 text-slate-500 text-xs">${b.category || '—'}</td>
        <td class="px-6 py-4">
          ${b.website ? `<a href="${b.website}" target="_blank" class="text-xs text-blue-500 hover:underline truncate max-w-[160px] block">Ver web →</a>` : '<span class="text-xs text-slate-300">Sin web</span>'}
        </td>
        <td class="px-6 py-4">${b.rating ? `<span class="text-amber-500 font-medium">★ ${b.rating}</span>` : '—'}</td>
        <td class="px-6 py-4 text-right">
          <button class="action-btn btn-scrape" onclick="scrapeOne('${b.id}', this)">⊙ Scrapear</button>
        </td>
      </tr>`).join('')
    : emptyRow(5, 'No hay negocios pendientes de scrapear. ¡Bien hecho!', '✓');

  // Done table (with search filter)
  renderScrapedDone(done, filter);
}

function renderScrapedDone(done, filter = '') {
  const q = filter.toLowerCase();
  const list = q ? done.filter(b => b.name.toLowerCase().includes(q) || (b.email||'').toLowerCase().includes(q)) : done;

  const doneCount = document.getElementById('scraped-done-count');
  if (doneCount) doneCount.textContent = `(${list.length})`;

  const tbody = document.getElementById('scraped-done-table');
  tbody.innerHTML = list.length
    ? list.map(b => `
      <tr class="table-row" id="scraped-row-${b.id}">
        <td class="px-6 py-4">
          <div class="font-medium text-slate-800">${b.name}</div>
          <div class="text-xs text-slate-400 mt-0.5">${b.address || ''}</div>
        </td>
        <td class="px-6 py-4 text-slate-500 text-xs">${b.category || '—'}</td>
        <td class="px-6 py-4">
          ${b.email
            ? `<a href="mailto:${b.email}" class="text-xs text-emerald-600 font-medium hover:underline">${b.email}</a>`
            : '<span class="text-xs text-red-400">Sin email</span>'}
        </td>
        <td class="px-6 py-4">
          ${b.phone
            ? `<a href="tel:${b.phone}" class="text-xs text-emerald-600 font-medium">📱 ${b.phone}</a>`
            : '<span class="text-xs text-red-400">Sin teléfono</span>'}
        </td>
        <td class="px-6 py-4">${badge(b.status)}</td>
        <td class="px-6 py-4 text-right">
          <button class="action-btn btn-scrape" onclick="rescrapeOne('${b.id}', this)" title="Re-scrapear para actualizar teléfono y datos">
            ↻ Re-scrapear
          </button>
        </td>
      </tr>`).join('')
    : emptyRow(6, 'Sin negocios scrapeados todavía.', '◈');
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
    tbody.innerHTML = emptyRow(4, 'No hay negocios scrapeados pendientes de generar.', '✦');
  } else {
    tbody.innerHTML = pending.map(b => `
      <tr class="table-row">
        <td class="px-6 py-4">
          <div class="font-medium text-slate-800">${b.name}</div>
        </td>
        <td class="px-6 py-4 text-slate-500">${b.category || '—'}</td>
        <td class="px-6 py-4 text-slate-500 text-xs">${b.address || '—'}</td>
        <td class="px-6 py-4 text-right">
          <button class="action-btn btn-generate" onclick="generateOne('${b.id}', this)">
            ✦ Generar web
          </button>
        </td>
      </tr>`).join('');
  }

  // Sites generated
  const sitesBody = document.getElementById('sites-table');
  if (!allSites.length) {
    sitesBody.innerHTML = emptyRow(6, 'Aún no hay webs generadas.', '◈');
  } else {
    sitesBody.innerHTML = allSites.map(s => `
      <tr class="table-row" id="site-row-${s.id}">
        <td class="px-6 py-4 font-medium text-slate-800">${s.businesses?.name || '—'}</td>
        <td class="px-6 py-4 font-mono text-xs text-slate-400">${s.slug}</td>
        <td class="px-6 py-4">${badge(s.status)}</td>
        <td class="px-6 py-4 text-xs text-slate-400">${fmtDate(s.expires_at)}</td>
        <td class="px-6 py-4">
          ${s.preview_url ? `<a href="${s.preview_url}" target="_blank" class="action-btn btn-preview">Ver →</a>` : '<span class="text-xs text-slate-300">Pendiente</span>'}
        </td>
        <td class="px-6 py-4">
          <button class="action-btn btn-generate" id="regen-btn-${s.id}" onclick="regenerateOne('${s.id}', this)">✦ Halo</button>
        </td>
      </tr>`).join('');
  }
}

function renderOutreach() {
  const toSend = allSites.filter(s => s.status === 'preview');
  const tbody = document.getElementById('outreach-table');

  // Update bulk-send counter
  const readyCount = toSend.filter(s => s.scraped_email).length;
  const countEl = document.getElementById('bulk-ready-count');
  if (countEl) countEl.textContent = readyCount;

  if (!toSend.length) {
    tbody.innerHTML = emptyRow(5, 'No hay webs listas para enviar. Genera webs primero.', '✉');
    return;
  }
  tbody.innerHTML = toSend.map(s => {
    const email = s.scraped_email;
    const sendBtn = email
      ? `<button class="action-btn btn-send" onclick="sendDirect('${s.id}', this)" title="Enviar a ${email}">
           ✉ Enviar a ${email}
         </button>`
      : `<button class="action-btn btn-secondary" onclick="openEmailModal('${s.id}')">
           ✉ Introducir email
         </button>`;
    return `
    <tr class="table-row" id="outreach-row-${s.id}">
      <td class="px-6 py-4">
        <div class="font-medium text-slate-800">${s.businesses?.name || '—'}</div>
        <div class="text-xs text-slate-400 mt-0.5">${s.businesses?.category || ''}</div>
      </td>
      <td class="px-6 py-4">
        ${email
          ? `<span class="text-xs text-emerald-600 font-medium">✓ ${email}</span>`
          : `<span class="text-xs text-red-400">Sin email</span>`}
      </td>
      <td class="px-6 py-4">
        <a href="${s.preview_url}" target="_blank" class="text-xs text-blue-500 hover:underline">Ver preview →</a>
      </td>
      <td class="px-6 py-4 text-xs text-slate-400">${fmtDate(s.expires_at)}</td>
      <td class="px-6 py-4 text-right">${sendBtn}</td>
    </tr>`;
  }).join('');
}

async function sendDirect(siteId, btn) {
  const original = btn.innerHTML;
  btn.textContent = 'Enviando...';
  btn.disabled = true;
  try {
    const r = await fetch(`/api/outreach/${siteId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (d.success) {
      toast(`✉ Email enviado a ${d.contact}`);
      const row = document.getElementById(`outreach-row-${siteId}`);
      if (row) row.remove();
    } else {
      toast('Error: ' + d.error, 'error');
      btn.innerHTML = original;
      btn.disabled = false;
    }
  } catch (e) {
    toast('Error de red', 'error');
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

async function renderFollowup() {
  const res = await fetch('/api/dashboard/outreach');
  const rows = await res.json();
  const tbody = document.getElementById('followup-table');
  if (!rows.length) {
    tbody.innerHTML = emptyRow(5, 'Sin emails enviados todavía.', '↻');
    return;
  }
  tbody.innerHTML = rows.map(o => `
    <tr class="table-row">
      <td class="px-6 py-4 font-medium text-slate-800">${o.businesses?.name || '—'}</td>
      <td class="px-6 py-4 text-xs text-slate-500">${o.contact || '—'}</td>
      <td class="px-6 py-4">
        <span class="badge badge-${o.follow_up_number === 0 ? 'generated' : 'sent'}">${o.follow_up_number === 0 ? 'Inicial' : `Follow-up ${o.follow_up_number}`}</span>
      </td>
      <td class="px-6 py-4 text-xs text-slate-400">${fmtDate(o.next_follow_up_at) !== '—' ? fmtDate(o.next_follow_up_at) : '<span class="text-slate-300">—</span>'}</td>
      <td class="px-6 py-4 text-xs text-slate-400">${fmtDate(o.sent_at)}</td>
    </tr>`).join('');
}

async function renderPayments() {
  const res = await fetch('/api/dashboard/payments');
  const rows = await res.json();
  const tbody = document.getElementById('payments-table');
  if (!rows.length) {
    tbody.innerHTML = emptyRow(5, 'Sin pagos completados todavía.', '◎');
    return;
  }
  tbody.innerHTML = rows.map(p => `
    <tr class="table-row">
      <td class="px-6 py-4 font-medium text-slate-800">${p.businesses?.name || '—'}</td>
      <td class="px-6 py-4 font-semibold text-emerald-600">${p.amount ? `€${(p.amount / 100).toFixed(2)}` : '—'}</td>
      <td class="px-6 py-4">${badge(p.status)}</td>
      <td class="px-6 py-4">
        ${p.generated_sites?.preview_url ? `<a href="${p.generated_sites.preview_url}" target="_blank" class="text-xs text-blue-500 hover:underline">Ver →</a>` : '—'}
      </td>
      <td class="px-6 py-4 text-xs text-slate-400">${fmtDate(p.created_at)}</td>
    </tr>`).join('');
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function scrapeOne(id, btn) {
  const original = btn.innerHTML;
  btn.textContent = 'Scrapeando...';
  btn.disabled = true;
  try {
    const r = await fetch(`/api/scrape/${id}`, { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      toast('Scraping completado');
      await loadSection('scraping');
    } else {
      toast('Error: ' + d.error, 'error');
      btn.innerHTML = original;
      btn.disabled = false;
    }
  } catch (e) {
    toast('Error de red', 'error');
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

async function rescrapeOne(id, btn) {
  const original = btn.innerHTML;
  btn.textContent = 'Re-scrapeando...';
  btn.disabled = true;
  try {
    const r = await fetch(`/api/scrape/${id}`, { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      const phone = d.profile?.phone;
      toast(phone ? `✓ Actualizado — teléfono: ${phone}` : '✓ Re-scrapeado (sin teléfono encontrado)');
      await fetchAll();
      const done = allBusinesses.filter(b => ['scraped','generated','active'].includes(b.status));
      renderScrapedDone(done);
    } else {
      toast('Error: ' + d.error, 'error');
      btn.innerHTML = original;
      btn.disabled = false;
    }
  } catch (e) {
    toast('Error de red', 'error');
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

async function scrapeAll() {
  const pending = allBusinesses.filter(b => b.status === 'prospected');
  if (!pending.length) { toast('No hay negocios pendientes'); return; }

  const btn = document.getElementById('scrape-all-btn');
  btn.textContent = `Scrapeando 0/${pending.length}...`;
  btn.disabled = true;

  for (let i = 0; i < pending.length; i++) {
    btn.textContent = `Scrapeando ${i + 1}/${pending.length}...`;
    try {
      await fetch(`/api/scrape/${pending[i].id}`, { method: 'POST' });
    } catch {}
  }

  toast(`${pending.length} negocios scrapeados`);
  btn.textContent = 'Scrapear todos';
  btn.disabled = false;
  await loadSection('scraping');
}

async function generateOne(id, btn) {
  const original = btn.innerHTML;
  btn.textContent = 'Generando...';
  btn.disabled = true;
  try {
    const r = await fetch(`/api/generate/${id}`, { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      toast('Web generada');
      await loadSection('generation');
    } else {
      toast('Error: ' + d.error, 'error');
      btn.innerHTML = original;
      btn.disabled = false;
    }
  } catch (e) {
    toast('Error de red', 'error');
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

async function generateAll() {
  const pending = allBusinesses.filter(b => b.status === 'scraped');
  if (!pending.length) { toast('No hay negocios pendientes'); return; }

  const btn = document.getElementById('generate-all-btn');
  btn.disabled = true;

  for (let i = 0; i < pending.length; i++) {
    btn.textContent = `Generando ${i + 1}/${pending.length}...`;
    try {
      await fetch(`/api/generate/${pending[i].id}`, { method: 'POST' });
    } catch {}
  }

  toast(`${pending.length} webs generadas`);
  btn.textContent = 'Generar todas';
  btn.disabled = false;
  await loadSection('generation');
}

// ─── Email Modal ──────────────────────────────────────────────────────────────

function openEmailModal(siteId) {
  pendingSiteId = siteId;
  document.getElementById('email-modal').classList.remove('hidden');
  document.getElementById('modal-email').value = '';
  document.getElementById('modal-email').focus();
}

document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('email-modal').classList.add('hidden');
  pendingSiteId = null;
});

document.getElementById('email-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('email-modal')) {
    document.getElementById('email-modal').classList.add('hidden');
    pendingSiteId = null;
  }
});

document.getElementById('modal-send').addEventListener('click', async () => {
  const email = document.getElementById('modal-email').value.trim();
  if (!email || !pendingSiteId) return;

  const btn = document.getElementById('modal-send');
  btn.textContent = 'Enviando...';
  btn.disabled = true;

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
    btn.textContent = 'Enviar email';
    btn.disabled = false;
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

  btn.textContent = 'Prospectando...';
  btn.disabled = true;
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
      result.textContent = `${d.inserted} nuevos insertados de ${d.total_found} encontrados`;
      toast(`${d.inserted} negocios añadidos`);
      await loadSection('prospecting');
    }
  } catch {
    toast('Error de red', 'error');
  } finally {
    btn.textContent = 'Prospectar →';
    btn.disabled = false;
  }
});

// ─── Regenerate ───────────────────────────────────────────────────────────────

async function regenerateOne(siteId, btn) {
  const original = btn.innerHTML;
  btn.textContent = 'Generando...';
  btn.disabled = true;

  try {
    const r = await fetch(`/api/regenerate/${siteId}`, { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      toast('Regenerado y publicado en Vercel');
      await loadSection('generation');
    } else {
      toast('Error: ' + d.error, 'error');
      btn.innerHTML = original;
      btn.disabled = false;
    }
  } catch {
    toast('Error de red', 'error');
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

async function regenerateAll() {
  const btn = document.getElementById('regenerate-all-btn');
  btn.textContent = 'Iniciando...';
  btn.disabled = true;

  // Progress modal
  const progress = document.createElement('div');
  progress.id = 'regen-progress';
  progress.className = 'fixed inset-0 modal-backdrop flex items-center justify-center z-50';
  progress.innerHTML = `
    <div class="modal-box bg-white p-7 w-full max-w-md mx-4">
      <h2 class="text-base font-bold text-slate-800 mb-1">Regenerando con Halo Theme</h2>
      <p class="text-xs text-slate-400 mb-4">Generando HTML con Claude y desplegando en Vercel...</p>
      <div id="regen-log" class="bg-slate-50 rounded-lg p-3 text-xs font-mono text-slate-600 h-48 overflow-y-auto space-y-1"></div>
      <p id="regen-summary" class="text-xs text-slate-400 mt-3"></p>
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
            summary.textContent = `Completado: ${d.ok} OK, ${d.failed} errores de ${d.total} webs.`;
            toast(`${d.ok} webs regeneradas y publicadas en Vercel`);
          } else {
            const icon = d.status === 'ok' ? '✓' : d.status === 'error' ? '✕' : '–';
            const color = d.status === 'ok' ? 'text-emerald-600' : d.status === 'error' ? 'text-red-500' : 'text-slate-400';
            log.innerHTML += `<div class="${color}">${icon} ${d.slug}${d.status === 'ok' ? '' : ' — ' + (d.reason || '')}</div>`;
            log.scrollTop = log.scrollHeight;
          }
        } catch {}
      }
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }

  btn.textContent = '✦ Regenerar todas con Halo Theme';
  btn.disabled = false;

  setTimeout(() => {
    progress.remove();
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

  btn.textContent = '⏳ Ejecutando...';
  btn.disabled = true;
  logBox.classList.remove('hidden');
  entries.innerHTML = '';
  badge.className = 'badge badge-blue';
  badge.textContent = 'Ejecutando...';

  const stageLabel = { scrape: '🔍 Scraping', generate: '🎨 Generando web', outreach: '📧 Enviando email' };
  const statusIcon = { ok: '✓', error: '✕', skipped: '–' };
  const statusColor = { ok: 'text-emerald-600', error: 'text-red-500', skipped: 'text-slate-400' };

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
            entries.innerHTML += `<div class="mt-2 pt-2 border-t border-slate-100 font-semibold text-slate-700">
              ✓ Scrapeados: ${d.scraped} · Webs: ${d.generated} · Emails: ${d.sent} · Sin email: ${d.skipped_no_email} · Errores: ${d.errors}
            </div>`;
            loadStats();
          } else if (d.status === 'skipped') {
            badge.className = 'badge badge-blue';
            badge.textContent = 'Ya en ejecución';
          } else if (d.status === 'error') {
            badge.className = 'badge badge-red';
            badge.textContent = 'Error';
            entries.innerHTML += `<div class="text-red-500">✕ ${d.message}</div>`;
          } else if (d.stage) {
            const icon = statusIcon[d.status] || '·';
            const color = statusColor[d.status] || 'text-slate-500';
            const label = stageLabel[d.stage] || d.stage;
            const detail = d.email ? ` → ${d.email}` : d.preview_url ? ` → ${d.preview_url}` : d.reason ? ` — ${d.reason}` : '';
            entries.innerHTML += `<div class="${color}">${icon} [${label}] ${d.name || ''}${detail}</div>`;
            entries.scrollTop = entries.scrollHeight;
          }
        } catch {}
      }
    }
  } catch (e) {
    badge.className = 'badge badge-red';
    badge.textContent = 'Error';
    entries.innerHTML += `<div class="text-red-500">✕ ${e.message}</div>`;
  }

  btn.textContent = '▶ Ejecutar pipeline ahora';
  btn.disabled = false;
}

// ─── WhatsApp Tab ─────────────────────────────────────────────────────────────
let waQrPollTimer = null;

async function renderWhatsApp() {
  clearInterval(waQrPollTimer);
  await refreshWAStatus();
  // Poll every 5s while on this tab
  waQrPollTimer = setInterval(async () => {
    const tab = document.querySelector('[data-tab="whatsapp"]');
    if (!tab || !tab.classList.contains('active')) { clearInterval(waQrPollTimer); return; }
    await refreshWAStatus();
  }, 5000);
}

async function refreshWAStatus() {
  try {
    const d = await fetch('/api/whatsapp/status').then(r => r.json());
    applyWAStatus(d);
  } catch {
    applyWAStatus({ state: 'unavailable', qr: null });
  }
}

function applyWAStatus({ state, qr }) {
  const badge = document.getElementById('wa-status-badge');
  const desc = document.getElementById('wa-status-desc');
  const qrArea = document.getElementById('wa-qr-area');
  const qrImg = document.getElementById('wa-qr-img');
  const setupHelp = document.getElementById('wa-setup-help');
  const navDot = document.getElementById('wa-nav-dot');
  const connectBtn = document.getElementById('wa-connect-btn');

  // Nav dot color
  const dotColor = state === 'open' ? '#10B981' : state === 'unavailable' ? '#94A3B8' : '#F59E0B';
  if (navDot) navDot.style.background = dotColor;

  if (state === 'connecting' && !qr) {
    // Initializing — browser launching, QR not ready yet
    badge.className = 'badge badge-blue';
    badge.textContent = 'Iniciando...';
    desc.textContent = 'Cargando WhatsApp Web... el QR aparecerá en unos segundos.';
    qrArea.classList.add('hidden');
    setupHelp.classList.remove('hidden');
    if (connectBtn) { connectBtn.textContent = 'Iniciando...'; connectBtn.disabled = true; }
  } else if (state === 'unavailable') {
    badge.className = 'badge badge-pending';
    badge.textContent = 'No disponible';
    desc.textContent = 'WhatsApp no está disponible. Pulsa Conectar para iniciar.';
    qrArea.classList.add('hidden');
    setupHelp.classList.add('hidden');
    if (connectBtn) { connectBtn.textContent = 'Conectar'; connectBtn.disabled = false; }
  } else if (state === 'open') {
    badge.className = 'badge badge-active';
    badge.textContent = '● Conectado';
    desc.textContent = 'WhatsApp vinculado y listo. Los outreach incluirán mensaje de WhatsApp.';
    qrArea.classList.add('hidden');
    setupHelp.classList.add('hidden');
    if (connectBtn) { connectBtn.textContent = 'Conectado'; connectBtn.disabled = true; }
    clearInterval(waQrPollTimer);
  } else if (qr && state !== 'open') {
    badge.className = 'badge badge-blue';
    badge.textContent = 'Escanea el QR';
    desc.textContent = 'Escanea el código QR con tu WhatsApp para vincular el dispositivo.';
    setupHelp.classList.add('hidden');
    if (qr) {
      qrImg.src = qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`;
      qrArea.classList.remove('hidden');
    }
    if (connectBtn) { connectBtn.textContent = 'Actualizar QR'; connectBtn.disabled = false; }
  } else {
    badge.className = 'badge badge-pending';
    badge.textContent = 'Desconectado';
    desc.textContent = 'Pulsa "Conectar" para generar el código QR.';
    qrArea.classList.add('hidden');
    setupHelp.classList.add('hidden');
    if (connectBtn) { connectBtn.textContent = 'Conectar'; connectBtn.disabled = false; }
  }
}

async function connectWA() {
  const btn = document.getElementById('wa-connect-btn');
  btn.textContent = 'Conectando...';
  btn.disabled = true;
  try {
    const d = await fetch('/api/whatsapp/connect', { method: 'POST' }).then(r => r.json());
    if (d.error) { toast(d.error, 'error'); btn.textContent = 'Conectar'; btn.disabled = false; return; }
    applyWAStatus(d);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
    btn.textContent = 'Conectar';
    btn.disabled = false;
  }
}

async function disconnectWA() {
  if (!confirm('¿Desconectar WhatsApp? Tendrás que escanear el QR de nuevo.')) return;
  try {
    await fetch('/api/whatsapp/disconnect', { method: 'DELETE' });
    toast('WhatsApp desconectado');
    await refreshWAStatus();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function testWA() {
  const phone = document.getElementById('wa-test-phone').value.trim();
  const message = document.getElementById('wa-test-msg').value.trim();
  if (!phone) { toast('Introduce un teléfono', 'error'); return; }
  const btn = document.getElementById('wa-test-btn');
  btn.textContent = 'Enviando...';
  btn.disabled = true;
  try {
    const d = await fetch('/api/whatsapp/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message }),
    }).then(r => r.json());
    if (d.success) toast('✓ Mensaje enviado');
    else toast('Error: ' + d.error, 'error');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
  btn.textContent = 'Enviar prueba';
  btn.disabled = false;
}

// ─── Bulk Send ────────────────────────────────────────────────────────────────
async function sendAll() {
  const ready = allSites.filter(s => s.status === 'preview' && s.scraped_email);
  if (!ready.length) { toast('No hay negocios con email para enviar', 'error'); return; }

  const confirmed = confirm(`¿Enviar emails a los ${ready.length} negocio${ready.length > 1 ? 's' : ''} con email disponible?\n\nEsta acción no se puede deshacer.`);
  if (!confirmed) return;

  const btn = document.getElementById('send-all-btn');
  const logBox = document.getElementById('bulk-log');
  const entries = document.getElementById('bulk-log-entries');
  const statusBadge = document.getElementById('bulk-status-badge');

  btn.textContent = '⏳ Enviando...';
  btn.disabled = true;
  logBox.classList.remove('hidden');
  entries.innerHTML = '';
  statusBadge.className = 'badge badge-blue';
  statusBadge.textContent = 'Enviando...';

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
            entries.innerHTML += `<div class="text-slate-500">Procesando ${d.total} negocio${d.total !== 1 ? 's' : ''}...</div>`;
          } else if (d.status === 'ok') {
            const flag = '$497';
            const waIcon = d.wa ? ' 📱' : '';
            entries.innerHTML += `<div class="text-emerald-600">✓ ${d.name} → ${d.email} <span class="text-slate-400">${flag}${waIcon}</span></div>`;
            entries.scrollTop = entries.scrollHeight;
          } else if (d.status === 'skipped') {
            entries.innerHTML += `<div class="text-slate-400">– ${d.slug} — ${d.reason}</div>`;
            entries.scrollTop = entries.scrollHeight;
          } else if (d.status === 'error') {
            entries.innerHTML += `<div class="text-red-500">✕ ${d.slug} — ${d.reason}</div>`;
            entries.scrollTop = entries.scrollHeight;
          } else if (d.status === 'done') {
            statusBadge.className = 'badge badge-green';
            statusBadge.textContent = 'Completado';
            entries.innerHTML += `<div class="mt-2 pt-2 border-t border-slate-200 font-semibold text-slate-700">
              ✓ Enviados: ${d.sent} · Omitidos: ${d.skipped} · Errores: ${d.errors}
            </div>`;
            toast(`✉ ${d.sent} email${d.sent !== 1 ? 's' : ''} enviado${d.sent !== 1 ? 's' : ''}`);
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
    entries.innerHTML += `<div class="text-red-500">✕ ${e.message}</div>`;
    toast('Error: ' + e.message, 'error');
  }

  btn.textContent = '✉ Enviar a todos';
  btn.disabled = false;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
checkHealth();
loadStats();
loadSection('overview');
