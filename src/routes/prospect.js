import { Router } from 'express';
import supabase from '../db/supabase.js';
import { prospectBusinesses } from '../services/googlePlaces.js';

const router = Router();

router.post('/', async (req, res) => {
  const { zone, category } = req.body;
  if (!zone || !category) {
    return res.status(400).json({ error: 'zone and category are required' });
  }

  try {
    const businesses = await prospectBusinesses(zone, category);

    if (businesses.length === 0) {
      return res.json({ inserted: 0, message: 'No businesses found for this query' });
    }

    const { data, error } = await supabase
      .from('businesses')
      .upsert(businesses, { onConflict: 'place_id', ignoreDuplicates: true })
      .select('id');

    if (error) throw error;

    res.json({ inserted: data?.length ?? 0, total_found: businesses.length });
  } catch (err) {
    console.error('Prospect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
