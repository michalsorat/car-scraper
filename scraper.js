import { parse } from 'node-html-parser';
import { getListing, insertListing, updatePrice } from './db.js';

const BASE_PARAMS  = 'hledat=&rubriky=auto&hlokalita=&humkreis=25&cenaod=23000&cenado=35000&Submit=H%C4%BEada%C5%A5&order=';
const BASE_URL     = 'https://auto.bazos.sk/';
const OLLAMA_URL   = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'gemma4:4b';

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

function extractBazosId(url) {
  const m = url.match(/\/inzerat\/(\d+)\//);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────
//  FETCH
// ─────────────────────────────────────────────
async function fetchHTML(url) {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: HEADERS,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} pre ${url}`);
  return resp.text();
}

// ─────────────────────────────────────────────
//  PARSE OVERVIEW PAGE
//  Regex/selectors len pre štruktúrované polia: title, url, price
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
//  EXTRACT PAGE TEXT  (pre Ollamu)
// ─────────────────────────────────────────────
function extractPageText(html) {
  const doc = parse(html);
  const mainEl =
    doc.querySelector('.listainzeratu') ||
    doc.querySelector('#inzerat') ||
    doc.querySelector('.inzeratydetail') ||
    doc.querySelector('article') ||
    doc.querySelector('main') ||
    doc;

  const descEl = mainEl.querySelector('.popis') || mainEl.querySelector('.textpodsekce') ||
                 mainEl.querySelector('#popis')  || mainEl.querySelector('.reklamni_box');

  const description = (descEl ? descEl.text : mainEl.text).replace(/\s+/g, ' ').trim().substring(0, 300);
  const rawText     = mainEl.text.replace(/\s+/g, ' ').trim().substring(0, 2000);

  return { description, rawText };
}

// ─────────────────────────────────────────────
//  OLLAMA  —  AI extrakcia
// ─────────────────────────────────────────────
async function checkOllama() {
  try {
    const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function callOllama(title, rawText) {
  const prompt = `Analyzuj tento inzerát na auto a extrahuj hodnoty. Vráť VÝLUČNE JSON objekt, žiadny iný text.

Formát:
{"power_kw": číslo alebo null, "mileage_km": číslo alebo null, "year": číslo alebo null, "fuel": "Benzín" alebo "Diesel" alebo "Hybrid" alebo "Plug-in hybrid" alebo "Elektro" alebo null}

Poznámky:
- power_kw: výkon motora v kilowattoch (nie v koňoch)
- mileage_km: celkový nájazd v kilometroch
- year: rok výroby vozidla (4-ciferné číslo)
- fuel: typ paliva podľa zoznamu, alebo null ak nevieš určiť

Inzerát:
Názov: ${title}
Text: ${rawText.substring(0, 1500)}`;

  const resp = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
  const data   = await resp.json();
  const parsed = JSON.parse(data.response);

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
  if (/plug[- ]?in|phev/.test(f))      return 12;
  if (/mild[- ]?hybrid/.test(f))       return 15;
  if (/hybrid/.test(f))                return 15;
  if (/benz[ií]n/.test(f))             return 20;
  if (/elektr|bev/.test(f))            return 6;
  if (/diesel|nafta/.test(f))          return 4;
  return 0;
}
function scorePower(kw) {
  if (!kw) return 0;
  if (kw >= 151) return 25;
  if (kw >= 131) return 18;
  if (kw >= 110) return 10;
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
function scorePriceKw(pricePerKw, minPricePerKw) {
  if (!pricePerKw || !minPricePerKw || minPricePerKw <= 0) return 0;
  return Math.round((minPricePerKw / pricePerKw) * 20);
}

// ─────────────────────────────────────────────
//  MAIN SCRAPER
// ─────────────────────────────────────────────
export async function runScraper(emit, isAborted, maxPages = 0) {
  // ── Ollama check ──
  emit('progress', { pct: 2, label: 'Kontrolujem Ollamu...' });
  const ollamaOk = await checkOllama();
  if (!ollamaOk) {
    emit('error', { msg: 'Ollama nebeží. Spusti príkaz: ollama serve' });
    return;
  }
  emit('log', { msg: `✅ Ollama beží (model: ${OLLAMA_MODEL})` });

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

    if (listings.length < 20) {
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

  // ── Phase 2: Detail pages + Ollama (len pre nové) ──
  emit('progress', { pct: 30, label: 'Načítavam detaily inzerátov...' });
  const detailed   = [];
  let newCount     = 0;
  let cachedCount  = 0;

  for (let i = 0; i < uniqueListings.length; i++) {
    if (isAborted()) break;
    const listing = uniqueListings[i];
    const bazosId = extractBazosId(listing.url);
    const pct     = 30 + Math.round((i / uniqueListings.length) * 55);

    // Check DB cache
    const existing = bazosId ? getListing(bazosId) : null;
    if (existing) {
      if (existing.price !== listing.price && listing.price != null) {
        updatePrice(bazosId, listing.price);
        emit('log', { msg: `💰 Zmena ceny: ${existing.title?.substring(0, 40)} → ${listing.price} €` });
      }
      detailed.push({
        title:       existing.title || listing.title,
        url:         existing.url,
        price:       listing.price ?? existing.price,
        description: existing.description,
        year:        existing.year,
        mileage:     existing.mileage,
        power:       existing.power,
        fuel:        existing.fuel,
      });
      cachedCount++;
      emit('progress', { pct, label: `Cache ${i + 1}/${uniqueListings.length}: ${listing.title.substring(0, 40)}...` });
      continue;
    }

    // New listing – fetch + AI parse
    emit('progress', { pct, label: `Detail ${i + 1}/${uniqueListings.length}: ${listing.title.substring(0, 40)}...` });
    emit('log',      { msg: `🆕 Nový: ${listing.title.substring(0, 50)}` });

    try {
      const html                  = await fetchHTML(listing.url);
      const { description, rawText } = extractPageText(html);

      emit('log', { msg: `   🤖 AI parsovanie...` });
      const aiData = await callOllama(listing.title, rawText);
      emit('log', { msg: `   → výkon: ${aiData.power ?? '?'} kW | nájazd: ${aiData.mileage ?? '?'} km | rok: ${aiData.year ?? '?'} | palivo: ${aiData.fuel ?? '?'}` });

      const fullListing = {
        title: listing.title,
        url:   listing.url,
        price: listing.price,
        description,
        ...aiData,
      };

      if (bazosId) {
        insertListing({ bazos_id: bazosId, ...fullListing, ai_parsed: 1 });
      }

      detailed.push(fullListing);
      newCount++;
    } catch (e) {
      emit('log', { msg: `   ⚠️ Chyba: ${e.message}` });
      detailed.push({ ...listing, year: null, mileage: null, power: null, fuel: null, description: '' });
    }

    await sleep(300);
  }

  emit('log', { msg: `Nové: ${newCount}, z cache: ${cachedCount}` });

  // ── Phase 3: Filter ──
  const filtered = detailed.filter(l =>
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

  const priceKwValues = filtered.filter(l => l.price && l.power).map(l => l.price / l.power);
  const minPriceKw   = priceKwValues.length > 0 ? Math.min(...priceKwValues) : null;

  const scored = filtered.map(l => {
    const priceKwRatio = (l.price && l.power) ? l.price / l.power : null;
    const scores = {
      fuel:    scoreFuel(l.fuel),
      power:   scorePower(l.power),
      mileage: scoreMileage(l.mileage),
      priceKw: scorePriceKw(priceKwRatio, minPriceKw),
      year:    scoreYear(l.year),
    };
    const totalScore = scores.fuel + scores.power + scores.mileage + scores.priceKw + scores.year;
    return { ...l, scores, totalScore, priceKwRatio };
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
