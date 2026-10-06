// Dashboard: pipeline "LLCs nuevas" (leads from public sources and CSV files), separate from the Google Maps pipeline.
// Tabs: Fuentes (Connecticut registry + CSV import with column mapping) · Leads (funnel and table) · Envío (Instantly).
// Everything here comes from the public registry or from files, so every text is escaped before it goes into the page.

const LEADS_API = '/api/leads';
const CSV_MAX_BYTES = 8 * 1024 * 1024;   // the server accepts up to 10 MB of JSON

const STATUS = {
  new:           { label: 'Nuevo',           badge: 'badge-prospected' },
  queued:        { label: 'En Instantly',    badge: 'badge-blue' },
  emailed:       { label: 'Enviado',         badge: 'badge-sent' },
  engaged:       { label: 'Vio su web',      badge: 'badge-scraped' },
  requested:     { label: 'Pidió llamada',   badge: 'badge-generated' },
  replied:       { label: 'Respondió',       badge: 'badge-blue' },
  called:        { label: 'Llamado',         badge: 'badge-sent' },
  won:           { label: 'Ganado',          badge: 'badge-green' },
  lost:          { label: 'Perdido',         badge: 'badge-red' },
  unsubscribed:  { label: 'Baja',            badge: 'badge-prospected' },
  bounced:       { label: 'Rebotado',        badge: 'badge-red' },
  invalid_email: { label: 'Email inválido',  badge: 'badge-red' },
  rejected:      { label: 'Rechazado',       badge: 'badge-prospected' },
};
const FUNNEL = ['new', 'queued', 'emailed', 'engaged', 'requested', 'replied', 'called', 'won', 'lost'];
const DISCARDED = ['unsubscribed', 'bounced', 'invalid_email', 'rejected'];

// What you can mark by hand from each status
const NEXT_STATUS = {
  queued: ['replied'], emailed: ['replied'], engaged: ['replied', 'called', 'lost'], requested: ['called', 'lost'], replied: ['called', 'lost'], called: ['won', 'lost'],
};
const ACTION_LABEL = { replied: 'Respondió', called: 'Llamado', won: 'Ganado', lost: 'Perdido' };

const SECTORS = {
  construccion: 'Construcción', limpieza: 'Limpieza', jardineria: 'Jardinería', belleza: 'Belleza', comida: 'Comida', transporte: 'Transporte',
  taxes: 'Taxes / contabilidad', auto: 'Automoción', seguros: 'Seguros', salud: 'Salud', eventos: 'Eventos', otro: 'Otro',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const nf = (n) => Number(n || 0).toLocaleString('es-ES');
const $ = (id) => document.getElementById(id);

async function leadsApi(path, { method = 'GET', body } = {}) {
  const res = await fetch(LEADS_API + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function showLeadsError(msg) {
  document.querySelectorAll('.leads-error').forEach(el => { el.textContent = msg || ''; el.classList.toggle('hidden', !msg); });
}

// Disables the button and shows a spinner + `label` while `fn` runs; failures become a toast
async function withBusy(btn, label, fn) {
  const restore = busy(btn, label);
  try { return await fn(); } catch (e) { toast(e.message, 'error'); } finally { restore(); }
}

// Same as withBusy, but never touches the button's contents — for one (the autopilot toggle) that has its own child
// element (the switch's thumb): clearing textContent would destroy it.
async function withDisabled(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
}

const statLine = (label, value, cls = 'text-slate-800') =>
  `<div class="flex items-baseline justify-between gap-4 border-b border-black/[.04] py-2 text-[13px] last:border-0"><span class="text-slate-600">${esc(label)}</span><span class="font-semibold tabular-nums ${cls}">${nf(value)}</span></div>`;

function resultBox(title, dryRun, bodyHtml, notes = []) {
  return `
    <div class="fade-in overflow-hidden rounded-2xl border ${dryRun ? 'border-amber-200 bg-amber-50/60' : 'border-emerald-200 bg-emerald-50/60'}">
      <div class="flex items-center gap-2 px-4 py-3 text-[13px] font-semibold ${dryRun ? 'bg-amber-100/60 text-amber-800' : 'bg-emerald-100/60 text-emerald-800'}">
        ${ic(dryRun ? 'eye' : 'circle-check', 'h-4 w-4')}${esc(title)}
      </div>
      <div class="px-4 py-2">${bodyHtml}</div>
      ${notes.length ? `<div class="space-y-1.5 px-4 pb-4">${notes.map(n => `<p class="flex items-start gap-2 text-xs text-amber-800">${ic('triangle-alert', 'mt-px h-3.5 w-3.5 shrink-0')}${esc(n)}</p>`).join('')}</div>` : ''}
    </div>`;
}

// ─── Sidebar counter + funnel stats ──────────────────────────────────────────

let leadStats = null;

async function loadLeadStats() {
  try {
    leadStats = await leadsApi('/stats');
    set('count-leads-new', leadStats.byStatus.new || 0);
    showLeadsError('');
  } catch (e) {
    leadStats = null;
    showLeadsError(e.message);
  }
  return leadStats;
}

// ─── Tab dispatcher (called by loadSection in app.js) ────────────────────────

async function loadLeadsSection(tab) {
  try {
    if (tab === 'leads-sources') await loadLeadsSources();
    if (tab === 'leads-list') await loadLeadsList();
    if (tab === 'leads-send') await loadLeadsSend();
  } catch (e) {
    showLeadsError(e.message);
  }
}

// ─── Tab: Fuentes · Connecticut ──────────────────────────────────────────────

const FILTER_LABELS = {
  noEmail: 'Sin email', gestoriaDomain: 'Email de gestoría o asesoría', sharedEmail: 'Email compartido por 4+ empresas',
  nonOperating: 'Sin actividad real (holdings, alquiler…)', notLatino: 'Sin señal latina',
};
const SKIPPED_LABELS = {
  existing: 'Ya estaban guardados', suppressed: 'En tu lista de bajas', emailTaken: 'Su email ya es de otro lead', batchDuplicate: 'Email repetido en la misma tanda',
};

// Common tail of every import result: what was skipped, what enters, what doesn't and why
function importSummaryHtml(r) {
  const skipped = Object.entries(r.skipped || {}).filter(([, n]) => n).map(([k, n]) => statLine(SKIPPED_LABELS[k] || k, n, 'text-slate-500')).join('');
  const sectors = Object.entries(r.summary?.bySector || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(SECTORS[k] || k)} ${nf(n)}`).join(' · ');
  const prio = r.summary?.byPriority || {};
  return `
    ${skipped}
    ${r.invalidEmailCount ? statLine('Email con dominio que no existe (se guardan sin enviar)', r.invalidEmailCount, 'text-red-600') : ''}
    ${statLine(r.dryRun ? 'Leads nuevos que entrarían' : 'Leads nuevos listos para enviar', r.summary?.total, 'text-emerald-700')}
    ${r.summary?.total ? `<p class="mt-2 text-xs text-slate-500">Prioridad A: ${nf(prio.A)} · B: ${nf(prio.B)} · Con nombre en español: ${nf(r.summary.latinoStrong)}</p>
    <p class="mb-2 mt-1 text-xs text-slate-500">${sectors}</p>` : ''}`;
}

function ctResultHtml(r) {
  const filtered = Object.entries(r.stats || {}).filter(([k, n]) => FILTER_LABELS[k] && n)
    .map(([k, n]) => statLine(FILTER_LABELS[k], n, 'text-slate-500')).join('');
  const body = `
    ${statLine(`Registros descargados desde ${r.since}`, r.fetched)}
    ${filtered ? `<div class="mt-3 text-[11px] font-semibold uppercase tracking-[.08em] text-slate-400">Descartados por los filtros</div>${filtered}` : ''}
    ${importSummaryHtml(r)}`;
  return resultBox(r.dryRun ? 'Vista previa · no se ha guardado nada' : `Importación terminada · ${nf(r.inserted)} leads guardados`, r.dryRun, body, r.notes);
}

async function runCtIngest(dryRun, btn) {
  const raw = $('ct-days').value.trim();
  const days = raw ? Number(raw) : null;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) return toast('Los días deben ser un número entre 1 y 3650', 'error');

  await withBusy(btn, dryRun ? 'Comprobando…' : 'Importando…', async () => {
    const r = await leadsApi('/ingest/ct', { method: 'POST', body: { dryRun, ...(days ? { days } : {}) } });
    $('ct-result').innerHTML = ctResultHtml(r);
    $('ct-result').classList.remove('hidden');
    if (!dryRun) { toast(`${nf(r.inserted)} leads nuevos guardados`); await loadLeadStats(); renderCtLastRun(); }
  });
}

function renderCtLastRun() {
  const run = leadStats?.lastRun;
  $('ct-last-run').textContent = run
    ? `Última importación: ${new Date(run.ran_at).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${nf(run.inserted)} leads guardados · registros hasta el ${run.newest_registration || '—'}`
    : 'Todavía no has importado nada del registro.';
}

async function loadLeadsSources() {
  await loadLeadStats();
  renderCtLastRun();
}

// ─── Tab: Fuentes · CSV with column mapping ──────────────────────────────────

const MAPPING_KEY = 'wc360_csv_mapping';
const csv = { text: '', name: '', preview: null };   // name: shown in Envío to send just this import

function savedMapping() {
  try { return JSON.parse(localStorage.getItem(MAPPING_KEY) || '{}'); } catch { return {}; }
}
function saveMapping(mapping) {
  try { localStorage.setItem(MAPPING_KEY, JSON.stringify(mapping)); } catch { /* private mode: nothing to remember */ }
}

// The column the user chose last time wins when this file has it; otherwise the automatic guess
function initialMapping(preview) {
  const saved = savedMapping();
  const mapping = {};
  for (const f of preview.fields) mapping[f.key] = preview.headers.includes(saved[f.key]) ? saved[f.key] : preview.suggestedMapping[f.key];
  return mapping;
}

const currentMapping = () => Object.fromEntries([...document.querySelectorAll('#csv-mapping-grid select')].map(s => [s.dataset.field, s.value || null]));
const firstValue = (header) => (header ? (csv.preview.sample.map(r => r[header]).find(v => v) || '') : '');

function renderMapper(preview) {
  const mapping = initialMapping(preview);
  const options = (selected) => `<option value="">— no usar —</option>` + preview.headers.map(h => `<option value="${esc(h)}"${h === selected ? ' selected' : ''}>${esc(h)}</option>`).join('');

  $('csv-mapping-grid').innerHTML = preview.fields.map(f => `
    <div>
      <label class="label" for="map-${esc(f.key)}">${esc(f.label)}${f.required ? ' <span class="text-rose-500">*</span>' : ''}</label>
      <select id="map-${esc(f.key)}" data-field="${esc(f.key)}" class="input !py-2">${options(mapping[f.key])}</select>
      <div class="mt-1 truncate text-xs text-slate-400" data-example="${esc(f.key)}"></div>
    </div>`).join('');

  $('csv-sample').innerHTML = `
    <thead class="bg-slate-50"><tr class="text-[11px] uppercase tracking-[.06em] text-slate-500">${preview.headers.map(h => `<th class="whitespace-nowrap px-3 py-2 text-left font-semibold">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody class="divide-y divide-slate-100">${preview.sample.map(r => `<tr>${preview.headers.map(h => `<td class="max-w-[220px] truncate whitespace-nowrap px-3 py-2 text-slate-600">${esc(r[h])}</td>`).join('')}</tr>`).join('')}</tbody>`;

  $('csv-file-info').textContent = `${nf(preview.totalRows)} filas · ${preview.headers.length} columnas`;
  $('csv-mapper').classList.remove('hidden');
  updateMapperState();
}

function updateMapperState() {
  const mapping = currentMapping();
  document.querySelectorAll('#csv-mapping-grid [data-example]').forEach(el => {
    const v = firstValue(mapping[el.dataset.example]);
    el.textContent = v ? `Ej.: ${v}` : '';
  });
  document.querySelectorAll('#csv-mapping-grid select').forEach(s => s.classList.toggle('!border-emerald-300', Boolean(s.value)));
  const missing = csv.preview.fields.filter(f => f.required && !mapping[f.key]).map(f => f.label);
  $('csv-missing').textContent = missing.length ? `Falta indicar: ${missing.join(', ')}` : '';
  $('csv-check-btn').disabled = $('csv-import-btn').disabled = missing.length > 0;
}

function clearCsvFile() {
  $('csv-file').value = '';
  $('csv-file-row').classList.add('hidden');
  $('csv-mapper').classList.add('hidden');
  $('csv-result').classList.add('hidden');
  csv.text = '';
  csv.name = '';
  csv.preview = null;
}

async function onCsvFile(file) {
  $('csv-result').classList.add('hidden');
  $('csv-mapper').classList.add('hidden');
  if (!file) { $('csv-file-row').classList.add('hidden'); return; }
  $('csv-file-name').textContent = file.name;
  $('csv-file-row').classList.remove('hidden');
  if (file.size > CSV_MAX_BYTES) return toast('El archivo pesa más de 8 MB: divídelo en partes', 'error');
  try {
    csv.name = file.name;
    csv.text = await file.text();
    csv.preview = await leadsApi('/import/csv/preview', { method: 'POST', body: { csv: csv.text } });
    renderMapper(csv.preview);
  } catch (e) {
    csv.preview = null;
    toast(e.message, 'error');
  }
}

function csvResultHtml(r) {
  const problems = r.invalidCount
    ? `<div class="mt-2 border-t border-black/5 pt-1 pb-2">
        ${statLine('Filas descartadas (no se importan)', r.invalidCount, 'text-rose-600')}
        <ul class="space-y-0.5 text-xs text-slate-500">
          ${r.invalid.slice(0, 8).map(p => `<li>Línea ${nf(p.line)} · ${esc(p.name)} — ${esc(p.reason)}</li>`).join('')}
          ${r.invalidCount > 8 ? `<li>… y ${nf(r.invalidCount - 8)} más</li>` : ''}
        </ul></div>` : '';
  const body = `${statLine('Filas del archivo', r.totalRows)}${importSummaryHtml(r)}${problems}`;
  return resultBox(r.dryRun ? 'Comprobación · no se ha guardado nada' : `Importación terminada · ${nf(r.inserted)} leads guardados`, r.dryRun, body, r.notes);
}

async function runCsvImport(dryRun, btn) {
  await withBusy(btn, dryRun ? 'Comprobando…' : 'Importando…', async () => {
    const mapping = currentMapping();
    const r = await leadsApi('/import/csv', { method: 'POST', body: { csv: csv.text, mapping, filename: csv.name, dryRun } });
    saveMapping(mapping);
    $('csv-result').innerHTML = csvResultHtml(r);
    $('csv-result').classList.remove('hidden');
    if (!dryRun) { toast(`${nf(r.inserted)} leads guardados`); await loadLeadStats(); }
  });
}

// ─── Tab: Leads ──────────────────────────────────────────────────────────────

const view = { status: '', sector: '', priority: '', source: '', q: '', offset: 0, limit: 50, total: 0 };

const opt = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`;

function fillFilterOptions() {
  if ($('lf-status').options.length) return;
  $('lf-status').innerHTML = opt('', 'Todo estado') + Object.entries(STATUS).map(([k, s]) => opt(k, s.label)).join('') + opt(DISCARDED.join(','), 'Descartados (baja, rebote, inválido, rechazado)');
  $('lf-sector').innerHTML = opt('', 'Todo sector') + Object.entries(SECTORS).map(([k, l]) => opt(k, l)).join('');
}

// Colour of each status' dot in the funnel pills, matching its badge
const DOT = {
  'badge-prospected': 'bg-slate-400', 'badge-blue': 'bg-sky-500', 'badge-sent': 'bg-sky-500', 'badge-scraped': 'bg-amber-400',
  'badge-generated': 'bg-violet-500', 'badge-green': 'bg-emerald-500', 'badge-red': 'bg-rose-500',
};

function renderFunnel() {
  const by = leadStats?.byStatus || {};
  const discarded = DISCARDED.reduce((n, k) => n + (by[k] || 0), 0);
  const chip = (status, label, n, dot, active) => `
    <button data-funnel="${esc(status)}" class="stat-pill ${active ? 'is-active' : ''}" aria-pressed="${active}">
      <span class="h-2.5 w-2.5 rounded-full ${dot}"></span>
      <span><span class="block text-lg font-bold leading-none tabular-nums text-slate-900">${nf(n)}</span><span class="mt-1 block whitespace-nowrap text-xs font-medium text-slate-500">${esc(label)}</span></span>
    </button>`;
  $('leads-funnel').innerHTML = FUNNEL.map(k => chip(k, STATUS[k].label, by[k] || 0, DOT[STATUS[k].badge], view.status === k)).join('')
    + chip(DISCARDED.join(','), 'Descartados', discarded, 'bg-slate-300', view.status === DISCARDED.join(','));
}

// Who to call: the phone they typed (tap to call), their name and when they prefer
const requestInfo = (l) => `
  <a href="tel:${esc(l.phone)}" class="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-2 py-1 text-xs font-semibold text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-100">${ic('phone-call', 'h-3.5 w-3.5')}${esc(l.phone)}</a>
  <div class="mt-1 text-xs text-slate-500">${l.contact_name ? `${esc(l.contact_name)} · ` : ''}${esc(l.preferred_time || '')}${l.requested_at ? ` · pedida ${esc(fmtDate(l.requested_at))}` : ''}</div>`;

// The lead's demo website: a link when it's ready; a button to make it while the lead hasn't been sent yet
const demoLinkOf = (url) => `${String(url).replace(/\/+$/, '')}/?lang=es`;
function demoInfo(l) {
  const link = l.demo_url ? `<a href="${esc(demoLinkOf(l.demo_url))}" target="_blank" rel="noopener" class="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-violet-700 hover:underline">${ic('globe', 'h-3.5 w-3.5')}Ver web${ic('arrow-up-right', 'h-3 w-3')}</a>` : '';
  if (l.status !== 'new') return link ? `<div>${link}</div>` : '';
  if (l.demo_status === 'generating') return `<div class="mt-2 text-xs font-medium text-slate-500">Creando su web…</div>`;
  const label = l.demo_status === 'failed' ? 'Reintentar web' : l.demo_url ? 'Rehacer web' : 'Crear web';
  const title = l.demo_status === 'failed' && l.demo_error ? ` title="${esc(l.demo_error)}"` : '';
  return `<div class="mt-2 flex flex-wrap items-center gap-2">${link}<button data-demo="${esc(l.id)}"${title} class="action-btn btn-generate">${ic('wand-sparkles')}${label}</button></div>`;
}

const ACTION_STYLE = { replied: ['btn-send', 'message-circle'], called: ['btn-generate', 'phone'], won: ['btn-preview', 'trophy'], lost: ['btn-soft-danger', 'x'] };

function leadRow(l) {
  const st = STATUS[l.status] || { label: l.status, badge: 'badge-prospected' };
  const actions = (NEXT_STATUS[l.status] || []).map(a => {
    const [cls, icon] = ACTION_STYLE[a] || ['btn-secondary', 'check'];
    return `<button data-lead-action="${esc(a)}" data-id="${esc(l.id)}" class="action-btn ${cls}">${ic(icon)}${esc(ACTION_LABEL[a])}</button>`;
  }).join('');
  const flags = `${l.priority === 'A' ? '<span class="rounded-md bg-brand-50 px-1.5 py-0.5 text-[10.5px] font-bold text-brand-700" title="Sector conocido">A</span>' : ''}${l.latino_strong ? `<span title="Nombre en español">${ic('star', 'h-3.5 w-3.5 fill-amber-400 text-amber-400')}</span>` : ''}`;
  const status = `<span class="badge ${st.badge}">${esc(st.label)}</span>${l.status === 'requested' ? requestInfo(l) : ''}${demoInfo(l)}`;
  // On a phone the Estado and Acción columns don't fit: they go under the name instead
  return `
    <tr class="table-row">
      <td>${nameCell(l.name, `${l.city || '—'}${l.zip ? ` · ${l.zip}` : ''}`, true)}<div class="mt-1 max-w-[16rem] truncate pl-12 text-xs text-slate-400 lg:hidden">${esc(l.email)}</div>
        <div class="mt-2.5 pl-12 sm:hidden">${status}${actions ? `<div class="mt-2 flex flex-wrap gap-1.5">${actions}</div>` : ''}</div></td>
      <td class="hidden lg:table-cell"><span class="text-[13px] text-slate-600">${esc(l.email)}</span></td>
      <td class="hidden md:table-cell"><div class="flex items-center gap-1.5 whitespace-nowrap text-[13px] text-slate-600">${esc(SECTORS[l.sector] || l.sector || '—')}${flags}</div></td>
      <td class="hidden 2xl:table-cell text-[13px] text-slate-500">${l.registered_at ? fmtDate(l.registered_at) : '—'}</td>
      <td class="hidden sm:table-cell">${status}</td>
      <td class="hidden text-right sm:table-cell"><div class="ml-auto flex max-w-[12.5rem] flex-wrap justify-end gap-1.5">${actions}</div></td>
    </tr>`;
}

async function loadLeadsList() {
  fillFilterOptions();
  const qs = new URLSearchParams({ limit: view.limit, offset: view.offset });
  for (const k of ['status', 'sector', 'priority', 'source', 'q']) if (view[k]) qs.set(k, view[k]);
  const [{ total, leads }] = await Promise.all([leadsApi(`/?${qs}`), loadLeadStats()]);
  view.total = total;

  const filtered = Object.values({ s: view.status, c: view.sector, p: view.priority, o: view.source, q: view.q }).some(Boolean);
  $('leads-table').innerHTML = leads.length ? leads.map(leadRow).join('')
    : emptyRow(6, filtered ? 'Ningún lead con esos filtros.' : 'Todavía no hay leads. Impórtalos desde «Fuentes».', filtered ? 'search-x' : 'users');
  const from = total ? view.offset + 1 : 0;
  $('leads-range').textContent = `${nf(from)}–${nf(view.offset + leads.length)} de ${nf(total)}`;
  $('leads-prev').disabled = view.offset === 0;
  $('leads-next').disabled = view.offset + view.limit >= total;
  renderFunnel();
}

function setLeadFilter(key, value) {
  view[key] = value;
  view.offset = 0;
  loadLeadsSection('leads-list');
}

// ─── Tab: Envío ──────────────────────────────────────────────────────────────

// Autopilot: on/off + how many it sends per cycle. It runs in the campaign server's own crons (daily ingest, send every
// 3h), not here — this just reads and writes the setting it checks on every tick.
function setAutopilotToggle(enabled) {
  const btn = $('autopilot-toggle'), thumb = btn.querySelector('span');
  btn.setAttribute('aria-checked', String(enabled));
  btn.classList.toggle('bg-emerald-500', enabled);
  btn.classList.toggle('bg-slate-200', !enabled);
  thumb.classList.toggle('translate-x-6', enabled);
  thumb.classList.toggle('translate-x-1', !enabled);
  for (const [pill, prefix] of [[$('autopilot-pill'), ''], [$('ov-autopilot'), 'Autopilot ']]) {
    pill.className = `badge ${enabled ? 'badge-green' : 'badge-prospected'}`;
    pill.textContent = prefix + (enabled ? 'activo' : 'en pausa');
    pill.textContent = pill.textContent[0].toUpperCase() + pill.textContent.slice(1);
  }
}

// Overview card: where the LLC campaign stands, at a glance
async function renderOverviewCampaign() {
  const [stats, auto] = await Promise.all([loadLeadStats(), leadsApi('/autopilot').catch(() => null)]);
  if (auto) setAutopilotToggle(auto.enabled);
  const box = $('ov-campaign-body');
  if (!stats) {
    box.innerHTML = `<p class="col-span-2 rounded-xl bg-slate-50 p-4 text-[13px] text-slate-500">No se pudo cargar la campaña.</p>`;
    return;
  }
  const by = stats.byStatus || {};
  const sum = (...keys) => keys.reduce((n, k) => n + (by[k] || 0), 0);
  const tile = (label, n, icon, cls) => `
    <div class="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div class="flex items-center gap-1.5 text-xs font-medium text-slate-500">${ic(icon, `h-3.5 w-3.5 ${cls}`)}${esc(label)}</div>
      <div class="mt-1.5 text-xl font-bold tabular-nums text-slate-900">${nf(n)}</div>
    </div>`;
  box.innerHTML = tile('Por enviar', by.new, 'inbox', 'text-slate-400')
    + tile('En camino', sum('queued', 'emailed'), 'send', 'text-sky-500')
    + tile('Abrieron', sum('engaged', 'replied'), 'mouse-pointer-click', 'text-amber-500')
    + tile('Piden llamada', sum('requested', 'called'), 'phone-call', 'text-violet-500');
  if (by.requested) {
    box.insertAdjacentHTML('beforeend', `
      <button data-goto="leads-list" class="col-span-2 flex items-center gap-3 rounded-xl bg-gradient-to-r from-brand-500 to-violet-500 px-3.5 py-3 text-left text-white shadow-lift">
        ${ic('phone-call', 'h-5 w-5 shrink-0')}<span class="flex-1 text-[13px] font-semibold">${nf(by.requested)} ${by.requested === 1 ? 'persona espera' : 'personas esperan'} tu llamada</span>${ic('arrow-right', 'h-4 w-4')}
      </button>`);
  }
}

const autopilotStatusText = (s) => (s.enabled
  ? `Activado: busca leads cada día a las 7:00 (Nueva York) y ${s.demoAll ? 'crea las webs de todos los leads pendientes y envía todos los que estén listos' : `envía hasta ${nf(s.pushLimit)}`} cada 3 horas.`
  : 'Desactivado: no busca ni envía nada por su cuenta; puedes seguir haciéndolo tú a mano.');

async function loadAutopilot() {
  const s = await leadsApi('/autopilot').catch(() => null);
  if (!s) return;
  setAutopilotToggle(s.enabled);
  $('autopilot-limit').value = s.pushLimit;
  $('autopilot-all').checked = !!s.demoAll;
  $('autopilot-limit').disabled = !!s.demoAll;
  $('autopilot-status').textContent = autopilotStatusText(s);
}

async function toggleAutopilot(btn) {
  const enabled = btn.getAttribute('aria-checked') !== 'true';
  await withDisabled(btn, async () => {
    const s = await leadsApi('/autopilot', { method: 'PUT', body: { enabled } });
    setAutopilotToggle(s.enabled);
    $('autopilot-status').textContent = autopilotStatusText(s);
    toast(s.enabled ? 'Autopilot activado' : 'Autopilot desactivado');
  });
}

async function toggleAutopilotAll(box) {
  const demoAll = box.checked;
  if (demoAll && !await ask({
    title: '¿Activar el modo «todas»?',
    message: 'El autopilot creará las webs de TODOS los leads pendientes (cada una cuesta unos 0,05–0,15 $) y enviará todos los que estén listos a Instantly, sin límite por tanda.',
    confirm: 'Activar', icon: 'rocket',
  })) { box.checked = false; return; }
  await withDisabled(box, async () => {
    try {
      const s = await leadsApi('/autopilot', { method: 'PUT', body: { demoAll } });
      $('autopilot-limit').disabled = !!s.demoAll;
      $('autopilot-status').textContent = autopilotStatusText(s);
      toast(s.demoAll ? 'Modo «todas» activado' : 'Modo «todas» desactivado');
    } catch (e) { box.checked = !demoAll; throw e; }
  });
}

async function saveAutopilotLimit(btn) {
  const pushLimit = Number($('autopilot-limit').value);
  if (!Number.isInteger(pushLimit) || pushLimit < 1 || pushLimit > 1000) return toast('Indica un número entre 1 y 1000', 'error');
  await withBusy(btn, 'Guardando…', async () => {
    const s = await leadsApi('/autopilot', { method: 'PUT', body: { pushLimit } });
    $('autopilot-limit').value = s.pushLimit;
    $('autopilot-status').textContent = autopilotStatusText(s);
    toast('Guardado');
  });
}

// Which "new" leads the send targets. Empty string = no filter on that field.
const sendFilters = () => ({ source: $('send-source').value, batch: $('send-batch').value, sector: $('send-sector').value, priority: $('send-priority').value });

function fillSendFilterOptions() {
  if ($('send-sector').options.length) return;
  $('send-sector').innerHTML = opt('', 'Todo sector') + Object.entries(SECTORS).map(([k, l]) => opt(k, l)).join('');
}

// Only CSV imports have a "batch"; keep Origen and Importación from contradicting each other
function onSendSourceChange() {
  if ($('send-source').value !== 'csv_import') $('send-batch').value = '';
  updateSendCount();
}
function onSendBatchChange() {
  if ($('send-batch').value) $('send-source').value = 'csv_import';
  updateSendCount();
}

async function loadSendBatches() {
  const batches = await leadsApi('/import-batches').catch(() => []);
  const current = $('send-batch').value;
  $('send-batch').innerHTML = opt('', 'Todas') + batches.map(b => opt(b.batch, `${b.batch} (${nf(b.count)})`)).join('');
  if (batches.some(b => b.batch === current)) $('send-batch').value = current;
}

// The live count of "new" leads matching the filters (not just the grand total)
async function updateSendCount() {
  const f = sendFilters();
  const qs = new URLSearchParams({ status: 'new', limit: '1' });
  if (leadStats?.demos?.enabled) qs.set('demo', 'ready');   // with demos, only leads whose site is ready get sent
  for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
  const { total } = await leadsApi(`/?${qs}`).catch(() => ({ total: 0 }));
  $('send-new-count').textContent = nf(total);
  $('send-btn').disabled = total === 0;
  return total;
}

async function loadLeadsSend() {
  fillSendFilterOptions();
  const [stats, tpl] = await Promise.all([loadLeadStats(), leadsApi('/email-template'), loadSendBatches(), loadAutopilot()]);
  renderDemosCard(stats?.demos);
  $('tpl-version').textContent = tpl.demos ? 'Versión con demo: enlaza a la web de cada lead ({{web}}).' : 'Versión clásica: enlaza a la página para pedir la llamada.';
  $('tpl-subject').value = tpl.subject;
  $('tpl-body').value = tpl.body;
  $('tpl-vars').innerHTML = tpl.variables.map(v => `<code class="rounded-lg bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-100">{{${esc(v)}}}</code>`).join('');
  await updateSendCount();
  $('send-limit').max = 1000;
  if (!stats) return;

  const { dryRun, ready: configured } = stats.instantly;
  const mode = $('send-mode'), hint = $('send-hint');
  mode.className = `badge shrink-0 ${dryRun ? 'badge-pending' : configured ? 'badge-green' : 'badge-red'}`;
  mode.textContent = dryRun ? 'Modo prueba' : configured ? `Instantly listo · campaña ${stats.instantly.campaign || '?'}…` : 'Falta configurar';
  hint.className = `mt-4 rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed ${dryRun ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-rose-200 bg-rose-50 text-rose-700'}${!dryRun && configured ? ' hidden' : ''}`;
  hint.textContent = dryRun
    ? 'OUTREACH_DRY_RUN=true: al pulsar el botón no se envía nada a Instantly; solo se cuenta y se anota en el registro del servidor. Ponlo en false en tu .env para enviar de verdad.'
    : 'Instantly no está configurado. Revisa en tu .env: INSTANTLY_API_KEY, INSTANTLY_CAMPAIGN_ID, y CAMPAIGN_PUBLIC_URL.';

  $('poll-btn').disabled = !configured;
  $('poll-hint').textContent = configured
    ? 'El servidor de la campaña lo comprueba solo cada 5 minutos; aquí puedes hacerlo ahora mismo.'
    : 'Necesita Instantly configurado (arriba).';
}

function renderDemosCard(d) {
  if (!d) return;
  const pill = $('demos-pill'), hint = $('demos-hint');
  pill.className = `badge ${d.enabled ? 'badge-green' : 'badge-prospected'}`;
  pill.textContent = d.enabled ? 'Activadas' : 'Desactivadas';
  for (const k of ['ready', 'generating', 'failed']) $(`demos-${k}`).textContent = nf(d[k]);
  const problem = !d.columns ? 'Falta ejecutar de nuevo src/db/schema-new-business-leads.sql en Supabase (añade las columnas de las demos).'
    : !d.configured ? 'Faltan ANTHROPIC_API_KEY o VERCEL_TOKEN en tu .env: sin ellas no se pueden crear webs.'
    : !d.enabled ? 'Con LEAD_DEMOS=false se envía el email clásico. Para enviar demos: pega el texto con demo en Instantly y pon LEAD_DEMOS=true (aquí y en el servidor de la campaña).' : '';
  hint.className = `mt-4 rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed ${problem ? (d.enabled || !d.columns ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-amber-200 bg-amber-50 text-amber-800') : 'hidden'}`;
  hint.textContent = problem;
  $('demos-btn').disabled = !d.columns || !d.configured;
}

async function createDemos(btn) {
  await withBusy(btn, 'Creando webs… (≈1 min cada una)', async () => {
    const r = await leadsApi('/demos', { method: 'POST', body: { limit: 3 } });
    const lines = r.results.map(x => `<p class="flex items-start gap-2 py-1 text-[13px] ${x.ok ? 'text-slate-700' : 'text-rose-700'}">${ic(x.ok ? 'check' : 'x', 'mt-0.5 h-3.5 w-3.5 shrink-0')}<span>${esc(x.name)}${x.ok ? ` · <a class="font-semibold text-violet-700 hover:underline" href="${esc(demoLinkOf(x.url))}" target="_blank" rel="noopener">ver web</a>` : ` — ${esc(x.error)}`}</span></p>`).join('');
    $('demos-result').innerHTML = resultBox(r.results.length ? `${nf(r.created)} webs creadas${r.failed ? ` · ${nf(r.failed)} fallidas` : ''}` : 'No hay leads nuevos sin web', false, lines || '<p class="py-1 text-[13px] text-slate-600">Todos los leads nuevos ya tienen su web.</p>');
    $('demos-result').classList.remove('hidden');
  });
  await loadLeadsSend();
}

async function pollInstantly(btn) {
  await withBusy(btn, 'Comprobando…', async () => {
    const r = await leadsApi('/poll-instantly', { method: 'POST' });
    const body = statLine('Leads revisados', r.checked)
      + statLine('Actualizados (enviado, rebotado, respondió…)', r.updated, 'text-emerald-700')
      + (r.suppressed ? statLine('Bajas o rebotes añadidos a tu lista de supresión', r.suppressed, 'text-red-600') : '')
      + (r.replied ? statLine('Respuestas nuevas (te ha llegado un aviso a Telegram)', r.replied, 'text-emerald-700') : '');
    $('poll-result').innerHTML = resultBox('Comprobado', false, body);
    $('poll-result').classList.remove('hidden');
    await loadLeadStats();
  });
}

async function pushToInstantly(btn) {
  const limit = Number($('send-limit').value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return toast('Indica un número entre 1 y 1000', 'error');
  const filters = sendFilters();
  const filterCount = Object.values(filters).filter(Boolean).length;
  const dryRun = leadStats?.instantly?.dryRun;
  const filterNote = filterCount ? ' (con los filtros elegidos)' : '';
  if (!dryRun && !await ask({
    title: `¿Enviar hasta ${nf(limit)} leads a Instantly?`,
    message: `Entrarán en tu campaña${filterNote} y recibirán el email según su horario. Un lead enviado no se puede retirar desde aquí.`,
    confirm: 'Enviar a Instantly', icon: 'rocket',
  })) return;

  await withBusy(btn, 'Enviando…', async () => {
    const r = await leadsApi('/push', { method: 'POST', body: { limit, ...filters } });
    const body = r.dryRun
      ? statLine('Leads que se habrían enviado', r.pushed)
      : statLine('Enviados a Instantly', r.pushed, 'text-emerald-700') + (r.rejected ? statLine('Rechazados por Instantly (ya en tu cuenta, bloqueados o email no válido)', r.rejected, 'text-red-600') : '');
    $('send-result').innerHTML = resultBox(r.dryRun ? 'Modo prueba · no se ha enviado nada' : 'Enviado', r.dryRun, body);
    $('send-result').classList.remove('hidden');
    if (!r.dryRun) toast(`${nf(r.pushed)} leads enviados a Instantly`);
  });
  await loadLeadsSend();   // after the button is restored, so the count decides whether it stays enabled
}

async function copyField(id, btn) {
  const original = btn.dataset.label ??= btn.innerHTML;
  try {
    await navigator.clipboard.writeText($(id).value);
    btn.innerHTML = `${ic('check')}Copiado`;
    btn.classList.add('!text-emerald-600');
  } catch {
    $(id).select();
    btn.textContent = 'Pulsa Ctrl+C';
  }
  setTimeout(() => { btn.innerHTML = original; btn.classList.remove('!text-emerald-600'); }, 2000);
}

// ─── Events ──────────────────────────────────────────────────────────────────

$('ct-preview-btn').addEventListener('click', (e) => runCtIngest(true, e.currentTarget));
$('ct-import-btn').addEventListener('click', (e) => runCtIngest(false, e.currentTarget));

$('csv-file').addEventListener('change', (e) => onCsvFile(e.target.files[0]));
$('csv-file-clear').addEventListener('click', clearCsvFile);

// Drag & drop onto the drop zone: the file goes into the input, so everything else works as if it had been picked
{
  const zone = $('csv-drop');
  let depth = 0;
  zone.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone.classList.add('is-dragging'); });
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('is-dragging'); } });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('is-dragging');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    try { $('csv-file').files = e.dataTransfer.files; } catch { /* old browsers: the file is still read below */ }
    onCsvFile(file);
  });
  // Dropping a file anywhere else would make the browser open it and leave the dashboard
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}
$('csv-mapping-grid').addEventListener('change', updateMapperState);
$('csv-check-btn').addEventListener('click', (e) => runCsvImport(true, e.currentTarget));
$('csv-import-btn').addEventListener('click', (e) => runCsvImport(false, e.currentTarget));

for (const [id, key] of [['lf-status', 'status'], ['lf-sector', 'sector'], ['lf-priority', 'priority'], ['lf-source', 'source']]) {
  $(id).addEventListener('change', (e) => setLeadFilter(key, e.target.value));
}
let searchTimer;
$('lf-q').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => setLeadFilter('q', e.target.value.trim()), 300); });
$('leads-prev').addEventListener('click', () => { view.offset = Math.max(0, view.offset - view.limit); loadLeadsSection('leads-list'); });
$('leads-next').addEventListener('click', () => { view.offset += view.limit; loadLeadsSection('leads-list'); });

// A funnel chip filters by its status; clicking the active one clears the filter
$('leads-funnel').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-funnel]');
  if (!chip) return;
  const value = chip.dataset.funnel === view.status ? '' : chip.dataset.funnel;
  $('lf-status').value = value;
  setLeadFilter('status', value);
});

$('leads-table').addEventListener('click', async (e) => {
  const demoBtn = e.target.closest('[data-demo]');
  if (demoBtn) {
    await withBusy(demoBtn, 'Creando… ≈1 min', async () => {
      const r = await leadsApi(`/${encodeURIComponent(demoBtn.dataset.demo)}/demo`, { method: 'POST' });
      toast(`Web creada con la plantilla «${r.template}»`);
      await loadLeadsList();
    });
    return;
  }
  const btn = e.target.closest('[data-lead-action]');
  if (!btn) return;
  await withBusy(btn, '…', async () => {
    await leadsApi(`/${encodeURIComponent(btn.dataset.id)}`, { method: 'PATCH', body: { status: btn.dataset.leadAction } });
    await loadLeadsList();
  });
});

$('autopilot-toggle').addEventListener('click', (e) => toggleAutopilot(e.currentTarget));
$('autopilot-all').addEventListener('change', (e) => toggleAutopilotAll(e.currentTarget));
$('demos-btn').addEventListener('click', (e) => createDemos(e.currentTarget));
$('autopilot-save-btn').addEventListener('click', (e) => saveAutopilotLimit(e.currentTarget));
$('send-source').addEventListener('change', onSendSourceChange);
$('send-batch').addEventListener('change', onSendBatchChange);
$('send-sector').addEventListener('change', updateSendCount);
$('send-priority').addEventListener('change', updateSendCount);
$('send-btn').addEventListener('click', (e) => pushToInstantly(e.currentTarget));
$('poll-btn').addEventListener('click', (e) => pollInstantly(e.currentTarget));
document.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', () => copyField(btn.dataset.copy, btn)));

loadLeadStats();
