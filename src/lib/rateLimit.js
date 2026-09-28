// Small in-memory rate limiter (per key, fixed window). Good enough for a single instance; not shared between processes.
//   const limiter = createLimiter({ max: 10, windowMs: 10 * 60_000 });
//   if (limiter.hit(req.ip)) return res.status(429)…      // true = over the limit
export function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < t) hits.delete(k);   // keep memory bounded
      const h = hits.get(key);
      if (!h || h.reset < t) { hits.set(key, { count: 1, reset: t + windowMs }); return false; }
      h.count++;
      return h.count > max;
    },
    size: () => hits.size,
  };
}
