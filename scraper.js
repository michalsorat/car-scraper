import { parse } from 'node-html-parser';
import { getListing, insertListing, updateListing, updatePrice, clearAllNew } from './db.js';

const BASE_PARAMS   = 'hledat=&rubriky=auto&hlokalita=&humkreis=25&cenaod=23000&cenado=35000&Submit=H%C4%BEada%C5%A5&order=';
const BASE_URL      = 'https://auto.bazos.sk/';
const OLLAMA_MODEL  = 'gemma4:e2b';
const OLLAMA_URL    = 'http://localhost:11434/api/generate';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'sk-SK,sk;q=0.9,cs;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

function pageUrl(offset) {
  const crp   = offset > 0 ? `&crp=${offset}` : '&crp=';
  const query = `?${BASE_PARAMS}${crp}`;
  if (offset === 0) return `${BASE_URL}${query}`;
  return `${BASE_URL}${offset}/${query}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function extractBazosId(url) {
  const m = url.match(/\/inzerat\/(\d+)\//);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────
//  FETCH
// ─────────────────────────────────────────────
export async function fetchHTML(url) {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: HEADERS,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} pre ${url}`);
  return resp.text();
}

// ─────────────────────────────────────────────
//  PARSE OVERVIEW PAGE
// ─────────────────────────────────────────────
function parseOverviewPage(html) {
  const doc = parse(html);
  const listings = [];
  const seen = new Set();

  let candidates = doc.querySelectorAll('.inzerat, .inzeratyflex');
  if (candidates.length === 0) {
    candidates = doc.querySelectorAll('[class*="inzerat"]');
  }

  const items = candidates.length > 0
    ? candidates
    : doc.querySelectorAll('h2 a[href*=".html"]').map(a => a.parentNode);

  items.forEach(item => {
    const anchor = item.querySelector('h2 a') ||
                   item.querySelector('.nadpis a') ||
                   (item.tagName?.toLowerCase() === 'a' ? item : null);
    if (!anchor) return;

    const href = anchor.getAttribute('href') || '';
    if (!href || href === '#') return;
    const url = href.startsWith('http') ? href : 'https://auto.bazos.sk' + href;
    if (seen.has(url)) return;
    seen.add(url);

    const title = anchor.text.trim();
    if (!title) return;

    let price = null;
    const priceEl = item.querySelector('.inzeratycena') ||
                    item.querySelector('.cena') ||
                    item.querySelector('[class*="cena"]');
    if (priceEl) {
      const pm = priceEl.text.replace(/\s+/g, '').match(/(\d+)/);
      if (pm) price = parseInt(pm[1]);
    } else {
      for (const b of item.querySelectorAll('b, strong')) {
        const t = b.text.replace(/\s/g, '');
        if (/€/.test(t) || /\d{4,}/.test(t)) {
          const m = t.match(/(\d+)/);
          if (m && !price) price = parseInt(m[1]);
        }
      }
    }

    listings.push({ title, url, price });
  });

  return listings;
}

// ─────────────────────────────────────────────
//  EXTRACT CAR PARAMS  (tabuľka + celý text)
// ─────────────────────────────────────────────
export function extractCarParams(html) {
  const doc = parse(html);
  doc.querySelectorAll('script, style, noscript, iframe, head').forEach(el => el.remove());

  const mainEl =
    doc.querySelector('.listainzeratu') ||
    doc.querySelector('#inzerat') ||
    doc.querySelector('.inzeratydetail') ||
    doc.querySelector('body') ||
    doc;

  const descEl = mainEl.querySelector('.popis') || mainEl.querySelector('#popis') ||
                 mainEl.querySelector('.textpodsekce') || mainEl.querySelector('.reklamni_box');
  const description = (descEl ? descEl.text : '').replace(/\s+/g, ' ').trim().substring(0, 300);

  const lines = [];
  for (const row of mainEl.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('td, th');
    if (cells.length >= 2) {
      const key = cells[0].text.trim().replace(/:$/, '');
      const val = cells[1].text.trim();
      if (key && val) lines.push(`${key}: ${val}`);
    }
  }
  if (lines.length === 0) {
    for (const dt of mainEl.querySelectorAll('dt')) {
      const dd = dt.nextElementSibling;
      if (dd?.tagName?.toLowerCase() === 'dd') {
        const key = dt.text.trim().replace(/:$/, '');
        const val = dd.text.trim();
        if (key && val) lines.push(`${key}: ${val}`);
      }
    }
  }

  const bodyText = mainEl.text.replace(/\s+/g, ' ').trim().substring(0, 4000);

  return { description, params: lines.join('\n'), bodyText };
}

// ─────────────────────────────────────────────
//  CONCURRENCY HELPER
// ─────────────────────────────────────────────
async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ─────────────────────────────────────────────
//  BULLETPROOF REGEX EXTRAKCIA
//  Pre každý parameter zbierame VŠETKÝCH kandidátov,
//  skórujeme podľa kontextu a vyberáme najspoľahlivejší.
// ─────────────────────────────────────────────
export function regexExtract(title, params, bodyText = '') {
  const src      = `${title}\n${params}\n${bodyText}`;
  const titleEnd = title.length;
  const paramsEnd = titleEnd + 1 + params.length;

  // ── VÝKON (power) ──
  let power = null;
  {
    const cands = [];

    // Najvyššia priorita: riadok tabuľky s kľúčom "výkon" / "motor"
    const tblKw = params.match(
      /(?:výkon|motor(?:\s*výkon)?|príkon\s*motora)[^\n]{0,40}:\s*(\d{2,3}(?:[.,]\d)?)\s*[kK][wW]/i
    );
    if (tblKw) {
      cands.push({ val: Math.round(parseFloat(tblKw[1].replace(',', '.'))), score: 100 });
    }

    // "NNN/MMM kW/PS" — vzor kW/PS kombinácia, berieme kW časť
    for (const m of src.matchAll(/\b(\d{2,3})\/\d{2,4}\s*[kK][wW]\s*\/\s*(?:PS|hp)/g)) {
      const val = Math.round(parseFloat(m[1]));
      if (val >= 30 && val <= 750) cands.push({ val, score: 85 });
    }

    // Všetky "NNN kW" výskyty
    for (const m of src.matchAll(/\b(\d{2,4}(?:[.,]\d)?)\s*[kK][wW]\b/g)) {
      const val = Math.round(parseFloat(m[1].replace(',', '.')));
      if (val < 30 || val > 750) continue;

      const before = src.slice(Math.max(0, m.index - 70), m.index).toLowerCase();
      const after  = src.slice(m.index + m[0].length, Math.min(src.length, m.index + m[0].length + 30)).toLowerCase();

      let score = 20;
      if (/výkon|motor\s*výkon/.test(before))               score = 90;
      else if (/max(?:imálny)?|nom\.|menovit/.test(before)) score = 70;
      else if (/príkon|spotreb|nabíj|batéri|charg/.test(before)) score = 3;
      else if (/\/(ps|hp)\b/.test(after))                   score = 80; // "150 kW/204 PS"
      else if (m.index <= titleEnd)                          score = 55;
      else if (m.index <= paramsEnd)                         score = 40;

      cands.push({ val, score });
    }

    // PS / HP → prepočet na kW
    for (const m of src.matchAll(/\b(\d{2,4}(?:[.,]\d)?)\s*(?:PS|HP|hp|cv|CV)\b/g)) {
      const val = Math.round(parseFloat(m[1].replace(',', '.')) * 0.7355);
      if (val < 30 || val > 750) continue;
      const before = src.slice(Math.max(0, m.index - 70), m.index).toLowerCase();
      let score = 15;
      if (/výkon|motor/.test(before)) score = 65;
      cands.push({ val, score });
    }

    if (cands.length > 0) {
      cands.sort((a, b) => b.score - a.score);
      power = cands[0].val;
    }
  }

  // ── NÁJAZD (mileage) ──
  let mileage = null;
  {
    const cands = [];

    // Najvyššia priorita: riadok tabuľky s "najazdené / tachometer / počet km"
    const tblKm = params.match(
      /(?:najazdené|nájazd(?:ené)?|počet\s*km|tachometer|stav\s*tacho(?:metra)?|km\s*stav)[^\n]{0,25}:\s*([0-9][0-9 .,]{1,9})\s*km/i
    );
    if (tblKm) {
      const val = parseInt(tblKm[1].replace(/[ .,]/g, ''));
      if (val >= 500 && val <= 500000) cands.push({ val, score: 100 });
    }

    // "NNN NNN km" / "NNN.NNN km" / "NNN,NNN km" (európsky formát tisícov)
    for (const m of src.matchAll(/\b(\d{1,3})[. ,](\d{3})\s*km\b/gi)) {
      const val = parseInt(m[1] + m[2]);
      if (val < 500 || val > 500000) continue;
      const before = src.slice(Math.max(0, m.index - 80), m.index).toLowerCase();

      let score = 30;
      if (/najazdené|nájazd|tachometer|stav\s*tacho/.test(before)) score = 90;
      else if (/servis.*každ|každých.*km|interval.*km|km.*interval|olej.*výmen|výmen.*olej/.test(before)) score = 2;
      else if (/každých\s*$/.test(before)) score = 2;   // "každých 15 000 km" — pred číslom
      else if (/odporúčaných\s*$|výrobcom\s+odp/.test(before)) score = 2; // "odporúčaných 30 000 km"
      else if (/záruka|garancia/.test(before)) score = 3;
      else if (m.index <= titleEnd)  score = 55;
      else if (m.index <= paramsEnd) score = 40;

      cands.push({ val, score });
    }

    // Kompaktné "85000km" (bez medzery)
    for (const m of src.matchAll(/\b(\d{5,6})\s*km\b/gi)) {
      const val = parseInt(m[1]);
      if (val < 500 || val > 500000) continue;
      // Vylúčime ak je súčasťou väčšieho čísla (napr. URL)
      const charBefore = m.index > 0 ? src[m.index - 1] : ' ';
      if (/\d/.test(charBefore)) continue;

      const before = src.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
      let score = 25;
      if (/najazdené|nájazd|tachometer/.test(before)) score = 85;
      else if (/servis|interval|každých/.test(before)) score = 2;
      else if (m.index <= titleEnd)  score = 50;
      else if (m.index <= paramsEnd) score = 35;

      cands.push({ val, score });
    }

    // "85tkm" / "85tis.km" / "85tis km" v názve
    for (const m of title.matchAll(/\b(\d{2,3})\s*t(?:is\.?\s*km|km)\b/gi)) {
      const val = parseInt(m[1]) * 1000;
      if (val >= 500 && val <= 500000) cands.push({ val, score: 55 });
    }

    if (cands.length > 0) {
      cands.sort((a, b) => b.score - a.score);
      mileage = cands[0].val;
    }
  }

  // ── ROK VÝROBY (year) ──
  let year = null;
  {
    const cands = [];

    // Najvyššia priorita: riadok tabuľky "rok výroby / rok registrácie / r.v." — plný formát (2021, 2024...)
    const tblYear = params.match(
      /(?:rok[^\n]{0,25}(?:výrob|registr|uveden)|r\.?\s*v\.|ročník)[^\n]{0,15}:\s*(20(?:1[5-9]|2[0-9]))\b/i
    );
    if (tblYear) cands.push({ val: parseInt(tblYear[1]), score: 100 });

    // Skrátený formát MM/YY (napr. r.v.: 03/24 → 2024) — v tabuľkových parametroch
    const tblYearShort = params.match(
      /(?:rok[^\n]{0,25}(?:výrob|registr|uveden)|r\.?\s*v\.|ročník)[^\n]{0,20}:\s*\d{1,2}\/(\d{2})\b/i
    );
    if (tblYearShort) {
      const yy = parseInt(tblYearShort[1]);
      if (yy >= 15 && yy <= 35) cands.push({ val: 2000 + yy, score: 98 });
    }

    // Skrátený formát MM/YY kdekoľvek v texte s kontextom roku výroby
    for (const m of src.matchAll(/\b\d{1,2}\/(\d{2})\b/g)) {
      const yy = parseInt(m[1]);
      if (yy < 15 || yy > 35) continue;
      const before = src.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
      if (/rok.*výrob|rok.*registr|r\.?\s*v\.|ročník|vyroben/.test(before)) {
        cands.push({ val: 2000 + yy, score: 80 });
      }
    }

    // Všetky výskyty rokov 2015–2029
    const yearFreq = {};
    for (const m of src.matchAll(/\b(20(?:1[5-9]|2[0-9]))\b/g)) {
      const val = parseInt(m[1]);
      yearFreq[val] = (yearFreq[val] || 0) + 1;

      const before = src.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
      let score = 10;
      if (/rok.*výrob|rok.*registr|vyrobený|ročník|r\.v\./.test(before)) score = 85;
      else if (/model\s+rok|od\s+roku|facelift|verzia/.test(before))     score = 50;
      else if (m.index <= titleEnd)  score = 45;
      else if (m.index <= paramsEnd) score = 28;

      cands.push({ val, score });
    }

    // Bonus za viacnásobný výskyt rovnakého roka (konzistentnosť údajov)
    for (const c of cands) {
      if (yearFreq[c.val] >= 3)      c.score += 20;
      else if (yearFreq[c.val] >= 2) c.score += 10;
    }

    if (cands.length > 0) {
      cands.sort((a, b) => b.score - a.score);
      year = cands[0].val;
    }
  }

  // ── PALIVO (fuel) ──
  // Skórujeme každý typ podľa počtu a sily signálov.
  let fuel = null;
  {
    const tl = src.toLowerCase();
    const s  = { 'Plug-in hybrid': 0, 'Hybrid': 0, 'Elektro': 0, 'Diesel': 0, 'Benzín': 0 };

    // Plug-in hybrid
    if (/plug[- ]?in/.test(tl))              s['Plug-in hybrid'] += 55;
    if (/\bphev\b/.test(tl))                 s['Plug-in hybrid'] += 50;
    if (/rech?argeable.*hybrid/.test(tl))    s['Plug-in hybrid'] += 45;

    // Mild-hybrid / Hybrid
    if (/mild[- ]?hybrid/.test(tl))          s['Hybrid'] += 50;
    if (/\bmhev\b/.test(tl))                 s['Hybrid'] += 45;
    if (/\bhybrid\b/.test(tl))               s['Hybrid'] += 30;

    // Elektro (BEV)
    if (/elektrick[aáeéy]|full[- ]?electric/.test(tl)) s['Elektro'] += 60;
    if (/\bbev\b/.test(tl))                  s['Elektro'] += 50;
    if (/\be-tron\b/.test(tl))               s['Elektro'] += 50;
    if (/\bid\.\s*\d|\bid\s+\d/.test(tl))   s['Elektro'] += 50;
    if (/\bioniq\s*\d/.test(tl))             s['Elektro'] += 45;
    if (/e-golf/.test(tl))                   s['Elektro'] += 45;
    if (/\bev\b/.test(tl))                   s['Elektro'] += 22;
    if (/\bzoe\b/.test(tl))                  s['Elektro'] += 40;
    if (/\bmodel\s*[sy3x]\b/.test(tl))       s['Elektro'] += 35; // Tesla
    if (/\bkwh\b/.test(tl))                  s['Elektro'] += 35;

    // Diesel
    if (/\bdiesel\b/.test(tl))               s['Diesel'] += 60;
    if (/\bnafta\b/.test(tl))                s['Diesel'] += 55;
    if (/\btdi\b/.test(tl))                  s['Diesel'] += 48;
    if (/\bcdi\b/.test(tl))                  s['Diesel'] += 48;
    if (/\bhdi\b/.test(tl))                  s['Diesel'] += 48;
    if (/\bdci\b/.test(tl))                  s['Diesel'] += 48;
    if (/\bcrdi\b/.test(tl))                 s['Diesel'] += 48;
    if (/\bjtd[m]?\b/.test(tl))              s['Diesel'] += 48;
    if (/\bsdi\b/.test(tl))                  s['Diesel'] += 35;
    if (/\bd4[adet]?\b/.test(tl))            s['Diesel'] += 30;
    if (/\bd5\b/.test(tl))                   s['Diesel'] += 30;
    if (/\b\w+\d{2,3}d\b/.test(tl))          s['Diesel'] += 15; // napr. 320d, xDrive20d

    // Benzín
    if (/benzín|benzin/.test(tl))            s['Benzín'] += 60;
    if (/\bpetrol\b/.test(tl))               s['Benzín'] += 55;
    if (/\btsi\b/.test(tl))                  s['Benzín'] += 48;
    if (/\btfsi\b/.test(tl))                 s['Benzín'] += 48;
    if (/\bfsi\b/.test(tl))                  s['Benzín'] += 38;
    if (/\bgdi\b/.test(tl))                  s['Benzín'] += 42;
    if (/\bt-gdi\b/.test(tl))               s['Benzín'] += 42;
    if (/\b[s]?mpi\b/.test(tl))             s['Benzín'] += 38;
    if (/\bgti\b/.test(tl))                  s['Benzín'] += 32;
    if (/\bgsi\b/.test(tl))                  s['Benzín'] += 32;
    if (/\bsti\b/.test(tl))                  s['Benzín'] += 28;
    if (/\bvtec\b|\bi-vtec\b/.test(tl))     s['Benzín'] += 40;
    if (/\bturbo\b/.test(tl))               s['Benzín'] += 8; // slabý signál

    // Konflikt Elektro vs Hybrid: ak silné BEV signály, oslabíme hybrid
    if (s['Elektro'] >= 70) {
      s['Hybrid']          = Math.max(0, s['Hybrid']          - 25);
      s['Plug-in hybrid']  = Math.max(0, s['Plug-in hybrid']  - 25);
    }

    const best = Object.entries(s).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (best.length > 0) fuel = best[0][0];
  }

  return { power, mileage, year, fuel };
}

// ─────────────────────────────────────────────
//  OLLAMA  —  AI extrakcia všetkých polí
// ─────────────────────────────────────────────
export async function extractCarData(title, params, bodyText, emitLog) {
  const sections = [];
  if (params) sections.push(`Parametre (tabuľka):\n${params}`);
  if (bodyText) sections.push(`Text inzerátu:\n${bodyText}`);

  const prompt = `Extrahuj parametre auta. Vráť VÝLUČNE JSON objekt, žiadny iný text.

{"power_kw": výkon v kW ako číslo (ak PS/hp prepočítaj *0.7355) alebo null, "mileage_km": celkový nájazd v km ako číslo alebo null, "year": rok výroby ako 4-ciferné číslo alebo null, "fuel": "Benzín" alebo "Diesel" alebo "Hybrid" alebo "Plug-in hybrid" alebo "Elektro" alebo null}

Názov: ${title}
${sections.join('\n\n')}`;

  emitLog(`   🤖 Ollama parsuje...`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);

  let resp;
  try {
    resp = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`Ollama nedostupné: ${e.message}`);
  }
  clearTimeout(timer);

  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);

  const data = await resp.json();
  const output = data.response || '';

  const match = output.match(/\{[\s\S]*?\}/);
  if (!match) throw new Error(`Ollama nevrátil JSON. Výstup: ${output.substring(0, 200)}`);

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch (e) { throw new Error(`Nepodarilo sa parsovať JSON: ${match[0].substring(0, 100)}`); }

  return {
    power:   typeof parsed.power_kw   === 'number' ? Math.round(parsed.power_kw)   : null,
    mileage: typeof parsed.mileage_km === 'number' ? Math.round(parsed.mileage_km) : null,
    year:    typeof parsed.year       === 'number' ? Math.round(parsed.year)        : null,
    fuel:    typeof parsed.fuel       === 'string' && parsed.fuel ? parsed.fuel     : null,
  };
}

// ─────────────────────────────────────────────
//  SCORING
// ─────────────────────────────────────────────
function scoreFuel(fuel) {
  if (!fuel) return 0;
  const f = fuel.toLowerCase();
  if (/plug[- ]?in|phev/.test(f))      return 0;
  if (/elektr|bev/.test(f))            return 0;
  if (/mild[- ]?hybrid/.test(f))       return 14;
  if (/hybrid/.test(f))                return 14;
  if (/diesel|nafta/.test(f))          return 3;
  if (/benz[ií]n/.test(f))             return 20;
  return 0;
}
function scorePower(kw) {
  if (!kw) return 0;
  if (kw >= 200) return 18;
  if (kw >= 180) return 20;
  if (kw >= 130) return 25;
  if (kw >= 110) return 8;
  return 0;
}
function scoreMileage(km) {
  if (km === null || km === undefined) return 0;
  if (km <= 30000)  return 25;
  if (km <= 60000)  return 18;
  if (km <= 80000)  return 12;
  if (km <= 100000) return 6;
  return 0;
}
function scoreYear(y) {
  if (!y) return 0;
  if (y >= 2024) return 10;
  if (y === 2023) return 8;
  if (y === 2022) return 5;
  if (y === 2021) return 3;
  return 0;
}
function scorePrice(price) {
  if (!price) return 0;
  if (price <= 30000) return 0;
  if (price <= 32000) return -5;
  if (price <= 34000) return -10;
  return -15;
}

// ─────────────────────────────────────────────
//  SCORING EXPORT  (pre DB view)
// ─────────────────────────────────────────────
export function scoreListings(listings) {
  const filtered = listings.filter(l =>
    l.power >= 110 &&
    l.mileage !== null && l.mileage <= 100000 &&
    l.year >= 2021
  );
  const scored = filtered.map(l => {
    const scores = {
      fuel:    scoreFuel(l.fuel),
      power:   scorePower(l.power),
      mileage: scoreMileage(l.mileage),
      price:   scorePrice(l.price),
      year:    scoreYear(l.year),
    };
    return { ...l, scores, totalScore: scores.fuel + scores.power + scores.mileage + scores.price + scores.year };
  });
  scored.sort((a, b) => b.totalScore - a.totalScore);
  return scored.map((item, i) => ({ ...item, rank: i + 1 }));
}

// ─────────────────────────────────────────────
//  MAIN SCRAPER
// ─────────────────────────────────────────────
export async function runScraper(emit, isAborted, maxPages = 0, useAI = true) {
  clearAllNew();

  emit('log', { msg: useAI
    ? `✅ Režim: AI (model: ${OLLAMA_MODEL})`
    : '✅ Režim: Regex (bez AI)'
  });

  emit('progress', { pct: 5, label: 'Načítavam prehľadové stránky...' });
  emit('log', { msg: maxPages > 0 ? `Skenujeme ${maxPages} stránok.` : 'Skenujeme všetky stránky.' });

  // ── Phase 1: Collect listings ──
  const collectedListings = [];
  let pageOffset = 0;
  let pageCount  = 0;
  let stop       = false;

  while (!stop && !isAborted()) {
    const url     = pageUrl(pageOffset);
    const pageNum = pageOffset === 0 ? 1 : pageOffset / 20 + 1;
    emit('log',      { msg: `Stránka ${pageNum}: ${url}` });
    emit('progress', { pct: 5 + Math.min(pageCount * 5, 25), label: `Stránka ${pageNum}...` });

    let html;
    try {
      html = await fetchHTML(url);
    } catch (e) {
      emit('error', { msg: 'Nepodarilo sa načítať stránku: ' + e.message });
      break;
    }

    const listings = parseOverviewPage(html);
    emit('log', { msg: `  → parsovaných: ${listings.length} inzerátov` });
    if (listings.length === 0) {
      emit('log', { msg: 'Na stránke sa nenašli žiadne inzeráty – ukončujem.' });
      break;
    }

    collectedListings.push(...listings);

    if (listings.length === 0) {
      emit('log', { msg: 'Posledná stránka dosiahnutá.' });
      stop = true;
    }

    pageCount++;
    pageOffset += 20;

    if (maxPages > 0 && pageCount >= maxPages) {
      emit('log', { msg: `Dosiahnutý limit ${maxPages} stránok.` });
      stop = true;
    }
    if (!stop) await sleep(400);
  }

  emit('log', { msg: `Celkom inzerátov: ${collectedListings.length}` });

  // Deduplicate
  const seenUrls     = new Set();
  const uniqueListings = collectedListings.filter(l => {
    if (seenUrls.has(l.url)) return false;
    seenUrls.add(l.url);
    return true;
  });
  if (uniqueListings.length < collectedListings.length) {
    emit('log', { msg: `Deduplikácia: odstránených ${collectedListings.length - uniqueListings.length} duplikátov.` });
  }

  if (uniqueListings.length === 0) {
    emit('progress', { pct: 100, label: 'Hotovo' });
    emit('noResults', { reason: 'empty' });
    return;
  }

  emit('stats', { total: uniqueListings.length, pass: 0, pages: pageCount });

  // ── Phase 2a: Rozdeliť na cached vs. nové ──
  emit('progress', { pct: 30, label: 'Kontrolujem cache...' });
  let newCount    = 0;
  let cachedCount = 0;
  const detailed  = [];
  const toFetch   = [];

  for (const listing of uniqueListings) {
    const bazosId  = extractBazosId(listing.url);
    const existing = bazosId ? getListing(bazosId) : null;
    if (existing) {
      let priceDropped = false;
      const prevPrice  = existing.price;
      if (existing.price !== listing.price && listing.price != null) {
        priceDropped = listing.price < existing.price;
        updatePrice(bazosId, listing.price);
        const msg = priceDropped
          ? `💰 Zlava! ${existing.title?.substring(0, 35)} ${existing.price} → ${listing.price} €`
          : `💰 Zmena ceny: ${existing.title?.substring(0, 40)} → ${listing.price} €`;
        emit('log', { msg });
      }
      if (existing.ai_parsed === 1) {
        // AI parsované — dáta sú presné, použijeme cache
        cachedCount++;
        detailed.push({
          title:         existing.title || listing.title,
          url:           existing.url,
          price:         listing.price ?? existing.price,
          description:   existing.description,
          year:          existing.year,
          mileage:       existing.mileage,
          power:         existing.power,
          fuel:          existing.fuel,
          ai_parsed:     1,
          bazos_id:      bazosId,
          is_new:        existing.is_new  || false,
          hidden:        priceDropped ? false : (existing.hidden || false),
          price_dropped: priceDropped,
          prev_price:    priceDropped ? prevPrice : undefined,
        });
      } else {
        // Regex parsované — re-fetchujeme a aktualizujeme
        emit('log', { msg: `🔄 Re-parse (regex): ${listing.title.substring(0, 40)}` });
        toFetch.push({ listing, bazosId, isReParse: true, existingHidden: existing.hidden || false, priceDropped, prevPrice });
      }
    } else {
      toFetch.push({ listing, bazosId, isReParse: false, existingHidden: false, priceDropped: false, prevPrice: null });
    }
  }
  emit('log', { msg: `Cache: ${cachedCount}, nové na spracovanie: ${toFetch.length}` });

  // ── Phase 2b: Fetch HTML paralelne (max 5) ──
  if (toFetch.length > 0) {
    emit('progress', { pct: 35, label: `Sťahujem ${toFetch.length} detailových stránok...` });

    const fetched = await withConcurrency(toFetch, 5, async ({ listing, bazosId, isReParse, existingHidden, priceDropped, prevPrice }, i) => {
      if (isAborted()) return null;
      emit('progress', {
        pct: 35 + Math.round((i / toFetch.length) * 20),
        label: `Fetch ${i + 1}/${toFetch.length}: ${listing.title.substring(0, 40)}...`,
      });
      try {
        const html                               = await fetchHTML(listing.url);
        const { description, params, bodyText } = extractCarParams(html);
        return { listing, bazosId, isReParse, existingHidden, priceDropped, prevPrice, description, params, bodyText };
      } catch (e) {
        emit('log', { msg: `   ⚠️ Fetch chyba: ${listing.title.substring(0, 40)} — ${e.message}` });
        return null;
      }
    });

    // ── Phase 2c: Parsovanie (AI alebo Regex) ──
    emit('progress', { pct: 55, label: useAI ? 'AI parsovanie...' : 'Regex parsovanie...' });
    const valid = fetched.filter(Boolean);

    for (let i = 0; i < valid.length; i++) {
      if (isAborted()) break;
      const { listing, bazosId, isReParse, existingHidden, priceDropped, prevPrice, description, params, bodyText } = valid[i];

      emit('progress', {
        pct: 55 + Math.round((i / valid.length) * 30),
        label: `${useAI ? 'AI' : 'Regex'} ${i + 1}/${valid.length}: ${listing.title.substring(0, 40)}...`,
      });
      emit('log', { msg: `🆕 ${isReParse ? 'Re-parse' : 'Nový'}: ${listing.title.substring(0, 50)}` });

      let parsedData = { power: null, mileage: null, year: null, fuel: null };

      if (useAI) {
        try {
          parsedData = await extractCarData(listing.title, params, bodyText, msg => emit('log', { msg }));
        } catch (e) {
          emit('log', { msg: `   ⚠️ AI chyba: ${e.message}` });
        }
      } else {
        parsedData = regexExtract(listing.title, params, bodyText);
      }

      const aiParsedFlag = useAI ? 1 : 0;
      emit('log', {
        msg: `   → výkon: ${parsedData.power ?? '?'} kW | nájazd: ${parsedData.mileage ?? '?'} km | rok: ${parsedData.year ?? '?'} | palivo: ${parsedData.fuel ?? '?'} | zdroj: ${useAI ? 'AI' : 'Regex'}`,
      });

      const fullListing = { title: listing.title, url: listing.url, price: listing.price, description, ...parsedData, ai_parsed: aiParsedFlag };
      if (bazosId) {
        if (isReParse) {
          updateListing(bazosId, { ...parsedData, description, title: listing.title, price: listing.price ?? undefined, ai_parsed: aiParsedFlag });
        } else {
          insertListing({ bazos_id: bazosId, ...fullListing });
        }
      }

      detailed.push({
        ...fullListing,
        bazos_id:      bazosId,
        is_new:        !isReParse,
        hidden:        priceDropped ? false : existingHidden,
        price_dropped: priceDropped,
        prev_price:    priceDropped ? prevPrice : undefined,
      });
      newCount++;
    }
  }

  emit('log', { msg: `Nové: ${newCount}, z cache: ${cachedCount}` });

  // ── Phase 3: Filter ──
  const filtered = detailed.filter(l =>
    (!l.hidden || l.price_dropped) &&
    l.power >= 110 &&
    l.mileage !== null && l.mileage <= 100000 &&
    l.year >= 2021
  );

  emit('log',   { msg: `Filter: ${filtered.length} z ${detailed.length} prešlo.` });
  emit('stats', { total: uniqueListings.length, pass: filtered.length, pages: pageCount });

  if (filtered.length === 0) {
    emit('progress', { pct: 100, label: 'Hotovo' });
    emit('noResults', { reason: 'filter', total: detailed.length });
    return;
  }

  // ── Phase 4: Score ──
  emit('progress', { pct: 88, label: 'Hodnotím a zoraďujem...' });

  const scored = filtered.map(l => {
    const scores = {
      fuel:    scoreFuel(l.fuel),
      power:   scorePower(l.power),
      mileage: scoreMileage(l.mileage),
      price:   scorePrice(l.price),
      year:    scoreYear(l.year),
    };
    const totalScore = scores.fuel + scores.power + scores.mileage + scores.price + scores.year;
    return { ...l, scores, totalScore };
  });

  scored.sort((a, b) => b.totalScore - a.totalScore);

  // ── Phase 5: Emit results ──
  emit('progress', { pct: 95, label: 'Vykresľujem výsledky...' });
  emit('summary',  { total: detailed.length, pass: filtered.length, pages: pageCount });

  scored.forEach((item, i) => {
    emit('result', { ...item, rank: i + 1 });
  });

  emit('progress', { pct: 100, label: '✅ Hotovo!' });
  emit('log',      { msg: `Dokončené. ${scored.length} výsledkov.` });
}
