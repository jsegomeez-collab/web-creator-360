const BASE_URL = 'https://maps.googleapis.com/maps/api/place';

async function textSearch(query, pageToken = null) {
  const params = new URLSearchParams({
    query,
    key: process.env.GOOGLE_PLACES_API_KEY,
    language: 'es',
  });
  if (pageToken) params.set('pagetoken', pageToken);

  const res = await fetch(`${BASE_URL}/textsearch/json?${params}`);
  if (!res.ok) throw new Error(`Places text search failed: ${res.status}`);
  return res.json();
}

async function placeDetails(placeId) {
  const fields = 'place_id,name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,types';
  const params = new URLSearchParams({
    place_id: placeId,
    fields,
    key: process.env.GOOGLE_PLACES_API_KEY,
    language: 'es',
  });

  const res = await fetch(`${BASE_URL}/details/json?${params}`);
  if (!res.ok) throw new Error(`Places details failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}

function isChain(result) {
  const chainKeywords = ['mcdonald', 'burger king', 'starbucks', 'telepizza', 'dominos', 'kfc', 'subway', 'mercadona', 'lidl', 'aldi', 'carrefour', 'dia ', 'eroski'];
  const nameLower = (result.name || '').toLowerCase();
  return chainKeywords.some(k => nameLower.includes(k));
}

export async function prospectBusinesses(zone, category) {
  const query = `${category} en ${zone}`;
  const collected = [];
  let pageToken = null;
  let page = 0;

  do {
    if (page > 0) await new Promise(r => setTimeout(r, 2000));
    const data = await textSearch(query, pageToken);

    for (const result of (data.results || [])) {
      if (isChain(result)) continue;
      if (result.rating && result.rating < 3.0) continue;

      const details = await placeDetails(result.place_id);
      collected.push({
        place_id: result.place_id,
        name: details.name || result.name,
        address: details.formatted_address || result.formatted_address,
        phone: details.formatted_phone_number || null,
        website: details.website || null,
        category,
        rating: details.rating || result.rating || null,
      });
    }

    pageToken = data.next_page_token || null;
    page++;
  } while (pageToken && page < 3);

  return collected;
}
