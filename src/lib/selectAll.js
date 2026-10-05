// Every row of a query, page by page. Supabase (PostgREST) caps each response at the project's "Max rows" (1000 by
// default), whatever .limit() asks for — a plain .limit(50000) silently returns 1000.
//   const rows = await selectAll(() => db.from('t').select('status').eq('user_id', id).order('id'));
// `build` must return a NEW query each time (a query can only run once) with a stable order, so pages never overlap.
// It keeps reading until a page comes back empty, so it works whatever that cap is. `max` stops early.
export async function selectAll(build, { pageSize = 1000, max = Infinity } = {}) {
  const rows = [];
  while (rows.length < max) {
    const want = Math.min(pageSize, max - rows.length);
    const { data, error } = await build().range(rows.length, rows.length + want - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    rows.push(...data);
  }
  return rows;
}
