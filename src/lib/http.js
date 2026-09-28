// One JSON API call with retries on network errors, 429 and 5xx. Errors carry the service's own message.
// Shared by the Instantly and Calendly clients. `fetchImpl` and `sleep` can be replaced (tests).
const sleepDefault = (ms) => new Promise(r => setTimeout(r, ms));

export async function requestJson({ service, url, method = 'GET', headers = {}, body, fetchImpl = globalThis.fetch, sleep = sleepDefault, retries = 3, hint401 = '' }) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt >= retries) throw new Error(`No se pudo conectar con ${service}: ${err.message}`);
      await sleep(1000 * attempt);
      continue;
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(1000 * attempt); continue; }
    const detail = await res.json().then(j => j.message || j.error || JSON.stringify(j)).catch(() => res.statusText);
    throw new Error(`${service} respondió ${res.status}: ${detail}${res.status === 401 && hint401 ? ` ${hint401}` : ''}`);
  }
}
