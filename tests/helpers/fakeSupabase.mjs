// Fake Supabase client for tests: chainable query builder that is also "await"-able and records every operation.
// Per-table `handlers[table](ctx)` decide what a query returns. Return { __error: 'msg' } to simulate a DB error.
//   ctx = { table, op: 'select'|'insert'|'update'|'upsert', payload, filters: { col: value, 'col__in': [...] } }
export function createFakeDb() {
  const calls = [];
  const handlers = {};

  function builder(table) {
    const ctx = { table, op: 'select', payload: null, filters: {} };
    const finish = (single) => {
      calls.push({ table, op: ctx.op, payload: ctx.payload, filters: { ...ctx.filters } });
      let data = handlers[table]?.(ctx) ?? null;
      if (data && data.__error) return { data: null, error: { message: data.__error } };
      if (single) data = Array.isArray(data) ? (data[0] ?? null) : data;
      return { data, error: null };
    };
    const b = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(finish(false)).then(resolve, reject);
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(finish(true));
        return (...args) => {
          if (['insert', 'update', 'upsert'].includes(prop)) { ctx.op = prop; ctx.payload = args[0]; }
          else if (prop === 'eq') ctx.filters[args[0]] = args[1];
          else if (prop === 'in') ctx.filters[`${args[0]}__in`] = args[1];
          return b;
        };
      },
    });
    return b;
  }

  return {
    from: (table) => builder(table),
    calls,
    handlers,
    writes: (table, op) => calls.filter(c => c.table === table && c.op === op),
    reset() { calls.length = 0; for (const k of Object.keys(handlers)) delete handlers[k]; },
  };
}
