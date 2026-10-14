export const CACHE_KEY = 'papertrade:profit-path:v2';
export const MAX_AGE = 15 * 60000;
export const FIELDS = ['incomePerNew', 'incomePerNewNote', 'stakerShare', 'paperYield', 'paperYieldNote', 'currentCost', 'currentCostNote', 'supplyGrowth', 'pathState', 'burnHeading'];
export const TABLES = { pathCompare: 3, pathTable: 4, burnTable: 7, protocolHours: 7 };
const text = v => typeof v === 'string' && v.length <= 2000;
export function validProfitCache(value, now = Date.now()) {
  if (!value || value.version !== 2 || !Number.isSafeInteger(value.sampleAt) || !Number.isSafeInteger(value.savedAt) ||
      value.sampleAt > now + 5000 || value.savedAt > now + 5000 || value.savedAt < value.sampleAt || now - value.sampleAt > MAX_AGE) return false;
  if (!FIELDS.every(id => text(value.fields?.[id]))) return false;
  return Object.entries(TABLES).every(([id, count]) => Array.isArray(value.tables?.[id]) && value.tables[id].length <= 64 &&
    value.tables[id].every(row => ['', 'inactive-path'].includes(row.className) && Array.isArray(row.cells) &&
      (row.cells.length === count && row.cells.every(cell => (cell.span ?? 1) === 1) || row.cells.length === 1 && row.cells[0].span === count) &&
      row.cells.every(cell => text(cell.text) && text(cell.title))));
}
export function readProfitCache(storage, now = Date.now()) {
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw || raw.length > 100000) return null;
    const value = JSON.parse(raw);
    return validProfitCache(value, now) ? value : null;
  } catch { return null; }
}
export function writeProfitCache(storage, value, now = Date.now()) {
  if (!validProfitCache(value, now)) return false;
  try { const raw = JSON.stringify(value); if (raw.length > 100000) return false; storage.setItem(CACHE_KEY, raw); return true; }
  catch { return false; }
}
