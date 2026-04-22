import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, 'listings.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    bazos_id    TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    title       TEXT,
    price       INTEGER,
    description TEXT,
    year        INTEGER,
    mileage     INTEGER,
    power       INTEGER,
    fuel        TEXT,
    first_seen  TEXT,
    last_seen   TEXT,
    ai_parsed   INTEGER DEFAULT 0
  )
`);

export function getListing(bazosId) {
  return db.prepare('SELECT * FROM listings WHERE bazos_id = ?').get(bazosId);
}

export function insertListing(listing) {
  const now = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT OR IGNORE INTO listings
    (bazos_id, url, title, price, description, year, mileage, power, fuel, first_seen, last_seen, ai_parsed)
    VALUES (@bazos_id, @url, @title, @price, @description, @year, @mileage, @power, @fuel, @first_seen, @last_seen, @ai_parsed)
  `).run({ ...listing, first_seen: now, last_seen: now });
}

export function updatePrice(bazosId, price) {
  const now = new Date().toISOString().slice(0, 10);
  db.prepare('UPDATE listings SET price = ?, last_seen = ? WHERE bazos_id = ?').run(price, now, bazosId);
}
