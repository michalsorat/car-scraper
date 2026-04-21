import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import { runScraper } from './scraper.js';
import { generateResultsHTML } from './saveResults.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const app = express();
const PORT = 3000;

// Ensure results directory exists
await fs.mkdir(RESULTS_DIR, { recursive: true });

app.use(express.static(join(__dirname, 'public')));
app.use('/results', express.static(RESULTS_DIR));

// List saved result files
app.get('/api/results', async (req, res) => {
  const files = await fs.readdir(RESULTS_DIR).catch(() => []);
  const htmlFiles = files.filter(f => f.endsWith('.html')).sort().reverse();
  res.json(htmlFiles);
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

  const allResults = [];
  let summaryMeta = { totalScanned: 0, totalPages: 0 };

  const wrappedSend = (event, data) => {
    send(event, data);
    if (event === 'result') allResults.push(data);
    if (event === 'summary') summaryMeta = { totalScanned: data.total, totalPages: data.pages };
  };

  try {
    await runScraper(wrappedSend, () => aborted, maxPages);
  } catch (e) {
    send('error', { msg: e.message });
  }

  // Save results to HTML file
  if (allResults.length > 0 && !aborted) {
    try {
      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, '-').substring(0, 16);
      const filename = `scan-${ts}.html`;
      const html = generateResultsHTML(allResults, { ...summaryMeta, scanDate: now });
      await fs.writeFile(join(RESULTS_DIR, filename), html, 'utf8');
      send('saved', { filename, url: `/results/${filename}` });
    } catch (e) {
      send('log', { msg: `⚠️ Uloženie zlyhalo: ${e.message}` });
    }
  }

  send('done', {});
  res.end();
});

app.listen(PORT, () => {
  console.log(`\n🚗 Bazos Auto Skener beží na http://localhost:${PORT}\n`);
});
