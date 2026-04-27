import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'listings.json');

function load() {
  if (!existsSync(DB_PATH)) return {};
  try { return JSON.parse(readFileSync(DB_PATH, 'utf8')); } catch { return {}; }
}

function save(data) {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export function getListing(bazosId) {
  return load()[bazosId] ?? null;
}

export function insertListing(listing) {
  const data = load();
  if (data[listing.bazos_id]) return;
  const now = new Date().toISOString().slice(0, 10);
  data[listing.bazos_id] = { ...listing, first_seen: now, last_seen: now, is_new: true, hidden: false };
  save(data);
}

export function updatePrice(bazosId, newPrice) {
  const data = load();
  if (!data[bazosId]) return;
  const rec = data[bazosId];
  if (newPrice < rec.price) {
    rec.prev_price    = rec.price;
    rec.price_dropped = true;
    rec.hidden        = false;
  }
  rec.price     = newPrice;
  rec.last_seen = new Date().toISOString().slice(0, 10);
  save(data);
}

export function hideListing(bazosId) {
  const data = load();
  if (!data[bazosId]) return;
  data[bazosId].hidden = true;
  save(data);
}

export function clearAllNew() {
  const data = load();
  for (const id in data) {
    data[id].is_new       = false;
    data[id].price_dropped = false;
  }
  save(data);
}

export function getAllListings() {
  const data = load();
  return Object.values(data).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

export function getListingCount() {
  return Object.keys(load()).length;
}

export function updateListing(bazosId, fields) {
  const data = load();
  if (!data[bazosId]) return;
  const now = new Date().toISOString().slice(0, 10);
  Object.assign(data[bazosId], fields, { last_seen: now });
  save(data);
}
