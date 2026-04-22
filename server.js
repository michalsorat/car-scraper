import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runScraper, scoreListings } from './scraper.js';
import { getAllListings, getListingCount } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(express.static(join(__dirname, 'public')));

// DB listings endpoint – vracia všetky záznamy ohodnotené a zoradené
app.get('/api/listings', (req, res) => {
  const all    = getAllListings();
  const scored = scoreListings(all);
  res.json({ total: all.length, filtered: scored.length, results: scored });
});

// Počet záznamov v DB (pre badge v UI)
app.get('/api/listings/count', (req, res) => {
  res.json({ count: getListingCount() });
});

// Main scraping SSE endpoint
app.get('/api/scrape', async (req, res) => {
  const maxPages = Math.max(0, parseInt(req.query.maxPages) || 0);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    await runScraper(send, () => aborted, maxPages);
  } catch (e) {
    send('error', { msg: e.message });
  }

  send('done', {});
  res.end();
});

app.listen(PORT, () => {
  console.log(`\n🚗 Bazos Auto Skener beží na http://localhost:${PORT}\n`);
});
