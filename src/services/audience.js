// Which campaign (and language) a lead belongs to is told by its `source`:
//   ct_registry / csv_import …  new LLCs with a Latino signal  → Spanish   → Instantly campaign "llc"
//   ct_registry_us              new LLCs with NO Latino signal → English   → campaign "us"      ("americanos")
//   gmaps                       Google Maps, no website        → English   → campaign "maps"
// "Americano" only means "no Latino signal": the registry does not say the owner's origin.
export const MAPS_SOURCE = 'gmaps';
export const US_SOURCE = 'ct_registry_us';

export const ENGLISH_SOURCES = [MAPS_SOURCE, US_SOURCE];
export const isEnglishSource = (source) => ENGLISH_SOURCES.includes(source);

// The Instantly campaign a source goes to: 'llc' | 'maps' | 'us'
export const campaignOfSource = (source) => (source === MAPS_SOURCE ? 'maps' : source === US_SOURCE ? 'us' : 'llc');
