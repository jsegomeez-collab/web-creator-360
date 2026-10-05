// In-memory Supabase-like client WITH state, for multi-step simulations (a 25-day email sequence, several cycles a day…).
// Supports the calls the campaign code uses: select (honours the column list) / insert / update / upsert / delete, eq neq in gte gt lte lt is not like,
// order (several = tie-breakers), limit, range, single / maybeSingle, and `.select()` after update/insert to get the affected rows back.
//   const db = createMemoryDb({ new_business_leads: [ {...}, ... ] });
//   createMemoryDb(seed, { maxRows: 1000 })   → like Supabase's "Max rows": no select returns more rows than that
//   db.tables.new_business_leads   → live array of rows
//   db.failNext('new_business_leads', 'update', 'boom')   → the next matching operation returns { error }
let seq = 0;
const isIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);

function compare(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;   // SQL: comparing with NULL is never true
  if (isIso(a) && isIso(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

// 'id, name' → ['id', 'name'];  '*', nothing or embedded relations → null (all columns)
const columnList = (spec) => {
  if (typeof spec !== 'string' || /[*()]/.test(spec)) return null;
  const cols = spec.split(',').map(c => c.trim()).filter(Boolean);
  return cols.length ? cols : null;
};

export function createMemoryDb(seed = {}, { maxRows = Infinity } = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map(r => ({ ...r }));
  const failures = [];
  const log = [];
  const rowsOf = (name) => (tables[name] ??= []);

  function builder(table) {
    const q = { table, op: 'select', payload: null, options: {}, preds: [], orders: [], limit: null, range: null, returning: false, columns: null };

    const run = () => {
      log.push({ table, op: q.op, payload: q.payload });
      const fi = failures.findIndex(f => f.table === table && f.op === q.op && (!f.when || f.when(q.payload)));
      if (fi >= 0) { const [f] = failures.splice(fi, 1); return { data: null, error: { message: f.message } }; }

      const all = rowsOf(table);
      const matches = () => all.filter(r => q.preds.every(p => p(r)));
      const finishRows = (rows) => {
        let out = rows.map(r => ({ ...r }));
        if (q.orders.length) out.sort((a, b) => {
          for (const o of q.orders) { const c = compare(a[o.col], b[o.col]) ?? 0; if (c) return o.asc ? c : -c; }
          return 0;
        });
        if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
        if (q.limit != null) out = out.slice(0, q.limit);
        if (q.op === 'select') out = out.slice(0, maxRows);
        if (q.columns) out = out.map(r => Object.fromEntries(q.columns.map(c => [c, r[c]])));   // like PostgREST: only the columns asked for
        return out;
      };

      if (q.op === 'select') return { data: finishRows(matches()), error: null };

      if (q.op === 'insert' || q.op === 'upsert') {
        const incoming = (Array.isArray(q.payload) ? q.payload : [q.payload]).map(r => ({ ...r }));
        const conflictCols = q.op === 'upsert' ? String(q.options.onConflict || 'id').split(',').map(s => s.trim()) : [];
        const affected = [];
        for (const row of incoming) {
          row.id ??= `mem-${++seq}`;
          if (q.op === 'upsert') {
            const existing = all.find(r => conflictCols.every(c => r[c] === row[c]));
            if (existing) {
              if (!q.options.ignoreDuplicates) { Object.assign(existing, row); affected.push(existing); }
              continue;
            }
          }
          all.push(row);
          affected.push(row);
        }
        return { data: q.returning ? finishRows(affected) : null, error: null };
      }

      if (q.op === 'update') {
        const hit = matches();
        hit.forEach(r => Object.assign(r, q.payload));
        return { data: q.returning ? finishRows(hit) : null, error: null };
      }

      if (q.op === 'delete') {
        const hit = new Set(matches());
        tables[table] = all.filter(r => !hit.has(r));
        return { data: null, error: null };
      }
      throw new Error(`memoryDb: operación no soportada ${q.op}`);
    };

    const b = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(run()).then(resolve, reject);
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(run()).then(r => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }));
        return (...args) => {
          switch (prop) {
            case 'select': if (q.op !== 'select') q.returning = true; q.columns = columnList(args[0]); break;
            case 'insert': case 'update': case 'upsert': q.op = prop; q.payload = args[0]; q.options = args[1] || {}; break;
            case 'delete': q.op = 'delete'; break;
            case 'eq': q.preds.push(r => r[args[0]] === args[1]); break;
            case 'neq': q.preds.push(r => r[args[0]] !== args[1]); break;
            case 'in': q.preds.push(r => args[1].includes(r[args[0]])); break;
            case 'gte': q.preds.push(r => (compare(r[args[0]], args[1]) ?? -1) >= 0 && r[args[0]] != null); break;
            case 'gt': q.preds.push(r => (compare(r[args[0]], args[1]) ?? -1) > 0); break;
            case 'lte': q.preds.push(r => r[args[0]] != null && (compare(r[args[0]], args[1]) ?? 1) <= 0); break;
            case 'lt': q.preds.push(r => r[args[0]] != null && (compare(r[args[0]], args[1]) ?? 1) < 0); break;
            case 'is': q.preds.push(r => (r[args[0]] ?? null) === args[1]); break;
            case 'not': q.preds.push(args[1] === 'is' ? (r => (r[args[0]] ?? null) !== args[2]) : (() => true)); break;
            case 'like': { const re = new RegExp(`^${String(args[1]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`); q.preds.push(r => typeof r[args[0]] === 'string' && re.test(r[args[0]])); break; }
            case 'order': q.orders.push({ col: args[0], asc: args[1]?.ascending !== false }); break;
            case 'limit': q.limit = args[0]; break;
            case 'range': q.range = [args[0], args[1]]; break;
            default: break;
          }
          return b;
        };
      },
    });
    return b;
  }

  return {
    from: (table) => builder(table),
    tables,
    log,
    // `when(payload)` (optional) restricts the failure to matching operations, e.g. only updates that set sequence_step
    failNext: (table, op, message = 'simulated failure', when = null) => failures.push({ table, op, message, when }),
    rows: (table) => rowsOf(table),
  };
}
