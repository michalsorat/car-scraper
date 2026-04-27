import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  runScraper, scoreListings,
  fetchHTML, extractCarParams, extractCarData, extractBazosId,
} from './scraper.js';
import { getAllListings, getListingCount, updateListing, hideListing } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// DB listings endpoint – vracia všetky záznamy ohodnotené a zoradené
app.get('/api/listings', (req, res) => {
  const all     = getAllListings();
  const visible = all.filter(l => !l.hidden);
  const scored  = scoreListings(visible);
  res.json({ total: all.length, filtered: scored.length, results: scored });
});

// Skryť inzerát (označiť ako "nezaujíma ma")
app.post('/api/hide/:id', (req, res) => {
  hideListing(req.params.id);
  res.json({ ok: true });
});

// Počet záznamov v DB (pre badge v UI)
app.get('/api/listings/count', (req, res) => {
  res.json({ count: getListingCount() });
});

// Main scraping SSE endpoint
app.get('/api/scrape', async (req, res) => {
  const maxPages = Math.max(0, parseInt(req.query.maxPages) || 0);
  const useAI    = req.query.useAI !== '0';   // default: true; ?useAI=0 → regex

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
    await runScraper(send, () => aborted, maxPages, useAI);
  } catch (e) {
    send('error', { msg: e.message });
  }

  send('done', {});
  res.end();
});

// AI refresh pre jeden inzerát
app.post('/api/ai-refresh', async (req, res) => {
  const { url, title } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL chýba' });

  try {
    const html                              = await fetchHTML(url);
    const { description, params, bodyText } = extractCarParams(html);
    const aiData                            = await extractCarData(title || '', params, bodyText, () => {});

    const bazosId = extractBazosId(url);
    if (bazosId) updateListing(bazosId, { ...aiData, description });

    res.json({ ok: true, ...aiData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚗 Bazos Auto Skener beží na http://localhost:${PORT}\n`);
});
