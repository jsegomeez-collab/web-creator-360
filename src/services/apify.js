// Apify REST client: start an actor run, wait for it, read its results. `fetchImpl` and `sleep` can be replaced (tests).
// Needs APIFY_TOKEN. The token goes in the Authorization header, never in the URL (URLs end up in logs).
const BASE = 'https://api.apify.com/v2';
const sleepDefault = (ms) => new Promise(r => setTimeout(r, ms));

export const loadApifyConfig = (env = process.env) => ({
  token: String(env.APIFY_TOKEN || '').trim(),
  // "username~actor-name". The default scrapes Google Maps (it has the "places without website" filter and contact enrichment)
  actor: String(env.APIFY_MAPS_ACTOR || 'compass~crawler-google-places').trim(),
});

async function api(config, path, { method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().then(j => j.error?.message || JSON.stringify(j)).catch(() => res.statusText);
    throw new Error(`Apify respondió ${res.status}: ${detail}${res.status === 401 ? ' (¿APIFY_TOKEN correcto?)' : ''}`);
  }
  return res.json();
}

// Runs the actor and returns its dataset items. maxCostUsd makes Apify stop the run if it would spend more than that.
// → { items, costUsd, runId }
export async function runActor(config, input, { maxCostUsd = null, timeoutMs = 20 * 60_000, pollMs = 5000, fetchImpl, sleep = sleepDefault } = {}) {
  if (!config.token) throw new Error('Falta APIFY_TOKEN en tu .env');
  const q = maxCostUsd ? `?maxTotalChargeUsd=${encodeURIComponent(maxCostUsd)}` : '';
  const started = (await api(config, `/acts/${config.actor}/runs${q}`, { method: 'POST', body: input, fetchImpl })).data;
  const deadline = Date.now() + timeoutMs;
  let run = started;
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
    if (Date.now() > deadline) {
      await api(config, `/actor-runs/${started.id}/abort`, { method: 'POST', fetchImpl }).catch(() => {});
      throw new Error('Apify tardó demasiado: se canceló la búsqueda');
    }
    await sleep(pollMs);
    run = (await api(config, `/actor-runs/${started.id}`, { fetchImpl })).data;
  }
  if (run.status === 'FAILED' || run.status === 'TIMED-OUT') throw new Error(`La búsqueda de Apify terminó en ${run.status}`);

  // An aborted run (it hit maxCostUsd) still has the places it found before stopping
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await api(config, `/datasets/${run.defaultDatasetId}/items?clean=true&format=json&limit=1000&offset=${offset}`, { fetchImpl });
    if (!Array.isArray(page)) throw new Error('Apify no devolvió una lista de resultados');
    items.push(...page);
    if (page.length < 1000) break;
  }
  return { items, costUsd: run.usageTotalUsd ?? null, runId: started.id };
}
