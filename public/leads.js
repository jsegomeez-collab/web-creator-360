// Dashboard: pipeline "LLCs nuevas" (leads from public sources and CSV files), separate from the Google Maps pipeline.
// Tabs: Fuentes (Connecticut registry + CSV import with column mapping) · Leads (funnel and table) · Envío (Instantly).
// Everything here comes from the public registry or from files, so every text is escaped before it goes into the page.

const LEADS_API = '/api/leads';
const CSV_MAX_BYTES = 8 * 1024 * 1024;   // the server accepts up to 10 MB of JSON

const STATUS = {
  new:           { label: 'Nuevo',           badge: 'badge-prospected' },
  queued:        { label: 'En Instantly',    badge: 'badge-blue' },
  emailed:       { label: 'Enviado',         badge: 'badge-sent' },
  engaged:       { label: 'Abrió el enlace', badge: 'badge-scraped' },
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

// Disables the button and shows `label` while `fn` runs; failures become a toast
async function withBusy(btn, label, fn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } catch (e) { toast(e.message, 'error'); } finally { btn.innerHTML = original; btn.disabled = false; }
}

// Same as withBusy, but never touches the button's contents — for one (the autopilot toggle) that has its own child
// element (the switch's thumb): clearing textContent would destroy it.
async function withDisabled(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
}

const statLine = (label, value, cls = 'text-slate-700') =>
  `<div class="flex justify-between gap-4 py-1 text-sm"><span class="text-slate-500">${esc(label)}</span><span class="font-semibold ${cls}">${nf(value)}</span></div>`;

function resultBox(title, dryRun, bodyHtml, notes = []) {
  return `
    <div class="rounded-xl border ${dryRun ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'} p-4">
      <div class="text-xs font-semibold uppercase tracking-wide mb-2 ${dryRun ? 'text-amber-700' : 'text-emerald-700'}">${esc(title)}</div>
      ${bodyHtml}
      ${notes.map(n => `<p class="text-xs text-amber-700 mt-2">⚠ ${esc(n)}</p>`).join('')}
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
    ${r.summary?.total ? `<p class="text-xs text-slate-500 mt-1">Prioridad A: ${nf(prio.A)} · B: ${nf(prio.B)} · Con nombre en español: ${nf(r.summary.latinoStrong)}</p>
    <p class="text-xs text-slate-500 mt-1">${sectors}</p>` : ''}`;
}

function ctResultHtml(r) {
  const filtered = Object.entries(r.stats || {}).filter(([k, n]) => FILTER_LABELS[k] && n)
    .map(([k, n]) => statLine(FILTER_LABELS[k], n, 'text-slate-500')).join('');
  const body = `
    ${statLine(`Registros descargados desde ${r.since}`, r.fetched)}
    ${filtered ? `<div class="text-xs font-semibold text-slate-400 uppercase tracking-wide mt-2">Descartados por los filtros</div>${filtered}` : ''}
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
const csv = { text: '', preview: null };

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
      <label class="block text-xs font-medium text-slate-600 mb-1" for="map-${esc(f.key)}">${esc(f.label)}${f.required ? ' <span class="text-red-500">*</span>' : ''}</label>
      <select id="map-${esc(f.key)}" data-field="${esc(f.key)}" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">${options(mapping[f.key])}</select>
      <div class="text-xs text-slate-400 mt-1 truncate" data-example="${esc(f.key)}"></div>
    </div>`).join('');

  $('csv-sample').innerHTML = `
    <thead class="bg-slate-50"><tr class="text-slate-400 uppercase tracking-wider">${preview.headers.map(h => `<th class="px-3 py-2 text-left whitespace-nowrap">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody class="divide-y divide-slate-50">${preview.sample.map(r => `<tr>${preview.headers.map(h => `<td class="px-3 py-2 text-slate-600 whitespace-nowrap max-w-[220px] truncate">${esc(r[h])}</td>`).join('')}</tr>`).join('')}</tbody>`;

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
    ? `<div class="mt-3 border-t border-black/5 pt-2">
        ${statLine('Filas descartadas (no se importan)', r.invalidCount, 'text-red-600')}
        <ul class="text-xs text-slate-500 space-y-0.5">
          ${r.invalid.slice(0, 8).map(p => `<li>Línea ${nf(p.line)} · ${esc(p.name)} — ${esc(p.reason)}</li>`).join('')}
          ${r.invalidCount > 8 ? `<li>… y ${nf(r.invalidCount - 8)} más</li>` : ''}
        </ul></div>` : '';
  const body = `${statLine('Filas del archivo', r.totalRows)}${importSummaryHtml(r)}${problems}`;
  return resultBox(r.dryRun ? 'Comprobación · no se ha guardado nada' : `Importación terminada · ${nf(r.inserted)} leads guardados`, r.dryRun, body, r.notes);
}

async function runCsvImport(dryRun, btn) {
  await withBusy(btn, dryRun ? 'Comprobando…' : 'Importando…', async () => {
    const mapping = currentMapping();
    const r = await leadsApi('/import/csv', { method: 'POST', body: { csv: csv.text, mapping, dryRun } });
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

function renderFunnel() {
  const by = leadStats?.byStatus || {};
  const discarded = DISCARDED.reduce((n, k) => n + (by[k] || 0), 0);
  const chip = (status, label, n, active) => `
    <button data-funnel="${esc(status)}" class="stat-chip card px-4 py-3 text-left min-w-[110px] ${active ? 'ring-2 ring-indigo-400' : ''}">
      <div class="text-xl font-bold text-slate-800">${nf(n)}</div>
      <div class="text-xs text-slate-400 font-medium">${esc(label)}</div>
    </button>`;
  $('leads-funnel').innerHTML = FUNNEL.map(k => chip(k, STATUS[k].label, by[k] || 0, view.status === k)).join('')
    + chip(DISCARDED.join(','), 'Descartados', discarded, view.status === DISCARDED.join(','));
}

// Who to call: the phone they typed (tap to call), their name and when they prefer
const requestInfo = (l) => `<div class="text-xs mt-1"><a href="tel:${esc(l.phone)}" class="text-indigo-600 font-semibold">${esc(l.phone)}</a>${l.contact_name ? ` · ${esc(l.contact_name)}` : ''}</div><div class="text-xs text-slate-500">${esc(l.preferred_time || '')}${l.requested_at ? ` · pedida ${esc(fmtDate(l.requested_at))}` : ''}</div>`;

function leadRow(l) {
  const st = STATUS[l.status] || { label: l.status, badge: 'badge-prospected' };
  const actions = (NEXT_STATUS[l.status] || []).map(a =>
    `<button data-lead-action="${esc(a)}" data-id="${esc(l.id)}" class="action-btn btn-preview">${esc(ACTION_LABEL[a])}</button>`).join(' ');
  const flags = [l.priority === 'A' ? 'A' : '', l.latino_strong ? '★' : ''].filter(Boolean).join(' ');
  return `
    <tr class="table-row">
      <td class="px-6 py-3"><div class="font-medium text-slate-700">${esc(l.name)}</div><div class="text-xs text-slate-400">${esc(l.city || '—')}${l.zip ? ` · ${esc(l.zip)}` : ''}</div></td>
      <td class="px-6 py-3 text-slate-500">${esc(l.email)}</td>
      <td class="px-6 py-3 text-slate-500">${esc(SECTORS[l.sector] || l.sector || '—')} <span class="text-xs text-indigo-500 font-semibold whitespace-nowrap" title="A = sector conocido · ★ = nombre en español">${esc(flags)}</span></td>
      <td class="px-6 py-3 text-slate-400">${l.registered_at ? fmtDate(l.registered_at) : '—'}</td>
      <td class="px-6 py-3"><span class="badge whitespace-nowrap ${st.badge}">${esc(st.label)}</span>${l.status === 'requested' ? requestInfo(l) : ''}</td>
      <td class="px-6 py-3 text-right whitespace-nowrap">${actions}</td>
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
    : emptyRow(6, filtered ? 'Ningún lead con esos filtros.' : 'Todavía no hay leads. Impórtalos desde "Fuentes".', '☰');
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
}

const autopilotStatusText = (s) => (s.enabled
  ? `Activado: busca leads cada día a las 7:00 (Nueva York) y envía hasta ${nf(s.pushLimit)} cada 3 horas.`
  : 'Desactivado: no busca ni envía nada por su cuenta; puedes seguir haciéndolo tú a mano.');

async function loadAutopilot() {
  const s = await leadsApi('/autopilot').catch(() => null);
  if (!s) return;
  setAutopilotToggle(s.enabled);
  $('autopilot-limit').value = s.pushLimit;
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
  for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
  const { total } = await leadsApi(`/?${qs}`).catch(() => ({ total: 0 }));
  $('send-new-count').textContent = nf(total);
  $('send-btn').disabled = total === 0;
  return total;
}

async function loadLeadsSend() {
  fillSendFilterOptions();
  const [stats, tpl] = await Promise.all([loadLeadStats(), leadsApi('/email-template'), loadSendBatches(), loadAutopilot()]);
  $('tpl-subject').value = tpl.subject;
  $('tpl-body').value = tpl.body;
  $('tpl-vars').innerHTML = tpl.variables.map(v => `<code class="bg-slate-100 rounded px-1.5 py-0.5">{{${esc(v)}}}</code>`).join(' ');
  await updateSendCount();
  $('send-limit').max = 1000;
  if (!stats) return;

  const { dryRun, ready: configured } = stats.instantly;
  const mode = $('send-mode'), hint = $('send-hint');
  mode.className = `badge shrink-0 ${dryRun ? 'badge-pending' : configured ? 'badge-green' : 'badge-red'}`;
  mode.textContent = dryRun ? 'Modo prueba' : configured ? 'Instantly listo' : 'Falta configurar';
  hint.className = `text-xs rounded-lg px-3 py-2 mb-4 ${dryRun ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}${!dryRun && configured ? ' hidden' : ''}`;
  hint.textContent = dryRun
    ? 'OUTREACH_DRY_RUN=true: al pulsar el botón no se envía nada a Instantly; solo se cuenta y se anota en el registro del servidor. Ponlo en false en tu .env para enviar de verdad.'
    : 'Instantly no está configurado. Revisa en tu .env: INSTANTLY_API_KEY, INSTANTLY_CAMPAIGN_ID, y CAMPAIGN_PUBLIC_URL.';

  $('poll-btn').disabled = !configured;
  $('poll-hint').textContent = configured
    ? 'El servidor de la campaña lo comprueba solo cada 5 minutos; aquí puedes hacerlo ahora mismo.'
    : 'Necesita Instantly configurado (arriba).';
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
  const filterNote = filterCount ? ` (con los filtros elegidos)` : '';
  if (!dryRun && !confirm(`¿Enviar hasta ${nf(limit)} leads a la campaña de Instantly${filterNote}? Empezarán a recibir el email según el horario de la campaña.`)) return;

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
  try {
    await navigator.clipboard.writeText($(id).value);
    btn.textContent = '✓ Copiado';
  } catch {
    $(id).select();
    btn.textContent = 'Selecciona y pulsa Ctrl+C';
  }
  setTimeout(() => { btn.textContent = 'Copiar'; }, 2000);
}

// ─── Events ──────────────────────────────────────────────────────────────────

$('ct-preview-btn').addEventListener('click', (e) => runCtIngest(true, e.currentTarget));
$('ct-import-btn').addEventListener('click', (e) => runCtIngest(false, e.currentTarget));

$('csv-file').addEventListener('change', (e) => onCsvFile(e.target.files[0]));
$('csv-file-clear').addEventListener('click', clearCsvFile);
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
  const btn = e.target.closest('[data-lead-action]');
  if (!btn) return;
  await withBusy(btn, '…', async () => {
    await leadsApi(`/${encodeURIComponent(btn.dataset.id)}`, { method: 'PATCH', body: { status: btn.dataset.leadAction } });
    await loadLeadsList();
  });
});

$('autopilot-toggle').addEventListener('click', (e) => toggleAutopilot(e.currentTarget));
$('autopilot-save-btn').addEventListener('click', (e) => saveAutopilotLimit(e.currentTarget));
$('send-source').addEventListener('change', onSendSourceChange);
$('send-batch').addEventListener('change', onSendBatchChange);
$('send-sector').addEventListener('change', updateSendCount);
$('send-priority').addEventListener('change', updateSendCount);
$('send-btn').addEventListener('click', (e) => pushToInstantly(e.currentTarget));
$('poll-btn').addEventListener('click', (e) => pollInstantly(e.currentTarget));
document.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', () => copyField(btn.dataset.copy, btn)));

loadLeadStats();
