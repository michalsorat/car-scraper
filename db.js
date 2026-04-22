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
  data[listing.bazos_id] = { ...listing, first_seen: now, last_seen: now };
  save(data);
}

export function updatePrice(bazosId, price) {
  const data = load();
  if (!data[bazosId]) return;
  data[bazosId].price = price;
  data[bazosId].last_seen = new Date().toISOString().slice(0, 10);
  save(data);
}

export function getAllListings() {
  const data = load();
  return Object.values(data).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

export function getListingCount() {
  return Object.keys(load()).length;
}
