// Minimal CSV reader: BOM, quoted fields, escaped quotes, line breaks inside quotes, CRLF, and comma / semicolon / tab
// separators (Spanish Excel exports use ";"). → { headers, rows }, each row an object keyed by header.

// The separator is whichever of , ; tab appears most in the first line outside quotes
export function detectDelimiter(text) {
  const firstLine = String(text).replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
  const count = (d) => { let inQuotes = false, n = 0; for (const ch of firstLine) { if (ch === '"') inQuotes = !inQuotes; else if (ch === d && !inQuotes) n++; } return n; };
  const scores = [',', ';', '\t'].map(d => [d, count(d)]).sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : ',';
}

export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const delimiter = detectDelimiter(src);
  const table = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); table.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell.replace(/\r$/, '')); table.push(row); }

  const lines = table.filter(r => r.some(c => c.trim() !== ''));
  if (!lines.length) return { headers: [], rows: [], delimiter };

  // Blank headers get a placeholder and repeated ones a suffix, so every column stays addressable
  const seen = new Map();
  const headers = lines[0].map((h, i) => {
    const base = h.trim() || `columna_${i + 1}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
  const rows = lines.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { headers, rows, delimiter };
}
