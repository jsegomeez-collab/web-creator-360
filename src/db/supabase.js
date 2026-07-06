import { createClient } from '@supabase/supabase-js';

let _client = null;

function getSupabase() {
  if (!_client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in your .env file');
    }
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return _client;
}

export default new Proxy({}, {
  get(_, prop) {
    return (...args) => getSupabase()[prop](...args);
  },
});
