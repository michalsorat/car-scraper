import { parse } from 'node-html-parser';

const BASE_PARAMS = 'hledat=&rubriky=auto&hlokalita=&humkreis=25&cenaod=23000&cenado=35000&Submit=H%C4%BEada%C5%A5&order=';
const BASE_URL    = 'https://auto.bazos.sk/';

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

// ─────────────────────────────────────────────
//  FETCH  (no CORS proxy needed – server-side)
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
// ─────────────────────────────────────────────
function parseOverviewPage(html) {
  const doc = parse(html);
  const listings = [];
  const seen = new Set();

  let candidates = doc.querySelectorAll('.inzerat, .inzeratyflex');
  if (candidates.length === 0) {
    candidates = doc.querySelectorAll('[class*="inzerat"]');
  }

  // Fallback: collect parent nodes of h2 links
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

    // Price
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

    const descEl = item.querySelector('.popis') ||
                   item.querySelector('.opis') ||
                   item.querySelector('[class*="popis"]');
    const description = descEl ? descEl.text.trim().substring(0, 200) : '';

    listings.push({ title, url, price, description });
  });

  return listings;
}

// ─────────────────────────────────────────────
//  PARSE DETAIL PAGE
// ─────────────────────────────────────────────
function parseMileage(text) {
  // "75.800 km" — dot as SK/CZ thousands separator
  const m1 = text.match(/\b(\d{2,3})\.(\d{3})\b/);
  if (m1) { const v = +(m1[1] + m1[2]); if (v > 1000 && v < 999999) return v; }
  // "75 800" — space as thousands separator
  const m2 = text.replace(/\./g, '').match(/\b(\d[\d ]{2,8})\b/);
  if (m2) { const v = +m2[1].replace(/\s/g, ''); if (v > 1000 && v < 999999) return v; }
  return null;
}

function parseYear(text) {
  // "12/2023" — month/year manufacture format (most reliable)
  const m1 = text.match(/\b\d{1,2}\/(202[0-9])\b/);
  if (m1) return +m1[1];
  // Bare year — strip full dates (dd.mm.yyyy) first to avoid catching listing date
  const stripped = text.replace(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, '');
  const m2 = stripped.match(/\b(202[0-9])\b/);
  if (m2) return +m2[1];
  return null;
}

// Detect fuel from engine code abbreviations.
// Uses (?<![a-z]) / (?![a-z]) instead of \b because engine codes like "2.0TSi"
// have a digit before the code — \b doesn't fire between \w chars (0 and T both \w).
function fuelFromAbbr(text) {
  const t = text.toLowerCase();
  // Plug-in hybrid codes
  if (/phev|p-hev|(?<![a-z])gte(?![a-z])/.test(t))                                        return 'Plug-in hybrid';
  // Mild hybrid codes
  if (/(?<![a-z])mhev(?![a-z])|(?<![a-z])shev(?![a-z])/.test(t))                          return 'Mild hybrid';
  // Diesel engine codes
  if (/(?<![a-z])(?:tdi|cdi|dci|hdi|crdi|sdv|d4d|jtd|cdti|ddis)(?![a-z])/.test(t))       return 'Diesel';
  // Diesel numeric suffix: "520d", "330d", "220d" (digits immediately before "d", not followed by a letter)
  if (/\d+d(?![a-z])/.test(t))                                                              return 'Diesel';
  // Petrol engine codes
  if (/(?<![a-z])(?:tsi|tfsi|fsi|mpi|gti|gdi|t-gdi|vtec|ecotec|ecoboost|tgdi)(?![a-z])/.test(t)) return 'Benzín';
  // Electric codes
  if (/e-tron|(?<![a-z])id\.\d|ioniq/.test(t))                                             return 'Elektro';
  return null;
}

function parseFuel(text, title = '') {
  // 1. Engine code abbreviations from title — very reliable
  const fromTitle = fuelFromAbbr(title);
  if (fromTitle) return fromTitle;

  // 2. Engine code abbreviations anywhere in scoped text
  const fromText = fuelFromAbbr(text);
  if (fromText) return fromText;

  const t = text.toLowerCase();

  // 3. Explicit fuel keywords — strong signal
  if (/\bbenz[ií]n\b/.test(t))                     return 'Benzín';
  if (/\bnafta\b/.test(t))                          return 'Diesel';

  // 4. Electric keywords
  if (/\belektro\b|\belektr[ií]na\b|\bbev\b/.test(t)) return 'Elektro';

  // 5. Plug-in hybrid (before generic hybrid)
  if (/plug[- ]?in\s*hybrid|phev/.test(t))          return 'Plug-in hybrid';

  // 6. Mild hybrid (before generic hybrid)
  if (/mild[- ]?hybrid|48\s*v\s*hybrid|mhev/.test(t)) return 'Mild hybrid';

  // 7. Generic diesel / petrol keywords
  if (/\bdiesel\b/.test(t))                          return 'Diesel';
  if (/benzin/.test(t))                              return 'Benzín';

  // 8. Hybrid — last resort, the word appears often as a feature mention
  if (/\bhybrid\b/.test(t))                          return 'Hybrid';

  return null;
}

function parseDetailPage(html, listingTitle = '') {
  const doc = parse(html);
  const res = { year: null, mileage: null, power: null, fuel: null, description: '' };

  // Scope to main listing container — excludes "Podobné inzeráty" and other sidebar content
  const mainEl =
    doc.querySelector('.listainzeratu') ||
    doc.querySelector('#inzerat') ||
    doc.querySelector('.inzeratydetail') ||
    doc.querySelector('article') ||
    doc.querySelector('main') ||
    doc;

  // ── Strategy 1: td label/value pairs (most reliable) ──
  // Walk all td pairs: td[n] = label, td[n+1] = value
  const tds = mainEl.querySelectorAll('td');
  for (let i = 0; i < tds.length - 1; i++) {
    const label = tds[i].text.trim().toLowerCase().replace(/:/g, '');
    const value = tds[i + 1].text.trim();
    if (!value) continue;

    if (!res.year    && /rok\s*v[ýy]rob/.test(label)) {
      const m = value.match(/\d{4}/); if (m) res.year = +m[0];
    }
    if (!res.mileage && /najazde|km\s*stav|po[cč]et\s*km|tachom/.test(label) && !label.includes('cena')) {
      res.mileage = parseMileage(value);
    }
    if (!res.power   && /v[ýy]kon/.test(label)) {
      const m = value.match(/(\d+)/); if (m) res.power = +m[0];
    }
    if (!res.fuel    && /palivo|druh\s*paliva/.test(label)) {
      // Normalize the raw table value through fuel detection (catches "Benzín", "Nafta", abbreviations)
      res.fuel = parseFuel(value, listingTitle) || value.trim();
    }
  }

  // ── Strategy 2: regex on scoped text (main listing only) ──
  const scopedText = mainEl.text || '';

  if (!res.year)    { res.year    = parseYear(scopedText); }
  if (!res.mileage) {
    const m = scopedText.match(/najazde[nň][éy]?\s*:?\s*([\d\s.]+)\s*km/i);
    if (m) res.mileage = parseMileage(m[1]);
    if (!res.mileage) res.mileage = parseMileage(scopedText.match(/\b[\d\s.]{5,12}km/i)?.[0] || '');
  }
  if (!res.power)   {
    const m = scopedText.match(/(\d{2,3})\s*kw/i); if (m) res.power = +m[1];
  }
  if (!res.fuel)    { res.fuel    = parseFuel(scopedText, listingTitle); }

  // ── Description ──
  const descEl = mainEl.querySelector('.popis') || mainEl.querySelector('.textpodsekce') ||
                 mainEl.querySelector('#popis')  || mainEl.querySelector('.reklamni_box');
  res.description = (descEl ? descEl.text : scopedText).replace(/\s+/g, ' ').trim().substring(0, 300);

  return res;
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
  emit('progress', { pct: 5, label: 'Načítavam prehľadové stránky...' });
  emit('log', { msg: maxPages > 0 ? `Skenujeme ${maxPages} stránok.` : 'Skenujeme všetky stránky.' });

  // ── Phase 1: Collect listings ──
  const collectedListings = [];
  let pageOffset = 0;
  let pageCount = 0;
  let stop = false;

  while (!stop && !isAborted()) {
    const url = pageUrl(pageOffset);
    const pageNum = pageOffset === 0 ? 1 : pageOffset / 20 + 1;
    emit('log', { msg: `Stránka ${pageNum}: ${url}` });
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

  // Deduplicate across pages (TOP listings appear on multiple pages)
  const seenUrls = new Set();
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

  // ── Phase 2: Fetch detail pages ──
  emit('progress', { pct: 30, label: 'Načítavam detaily inzerátov...' });
  const detailed = [];

  for (let i = 0; i < uniqueListings.length; i++) {
    if (isAborted()) break;
    const listing = uniqueListings[i];
    const pct = 30 + Math.round((i / uniqueListings.length) * 55);
    emit('progress', { pct, label: `Detail ${i + 1}/${uniqueListings.length}: ${listing.title.substring(0, 40)}...` });
    emit('log', { msg: `Detail: ${listing.title.substring(0, 50)}` });

    try {
      const html = await fetchHTML(listing.url);
      const details = parseDetailPage(html, listing.title);
      detailed.push({ ...listing, ...details });
    } catch (e) {
      emit('log', { msg: `  ⚠️ Nepodarilo sa načítať detail: ${e.message}` });
      detailed.push({ ...listing, year: null, mileage: null, power: null, fuel: null });
    }

    await sleep(300);
  }

  // ── Phase 3: Filter ──
  const filtered = detailed.filter(l =>
    l.power >= 110 &&
    l.mileage !== null && l.mileage <= 100000 &&
    l.year >= 2021
  );

  emit('log', { msg: `Filter: ${filtered.length} z ${detailed.length} prešlo.` });
  emit('stats', { total: uniqueListings.length, pass: filtered.length, pages: pageCount });

  if (filtered.length === 0) {
    emit('progress', { pct: 100, label: 'Hotovo' });
    emit('noResults', { reason: 'filter', total: detailed.length });
    return;
  }

  // ── Phase 4: Score ──
  emit('progress', { pct: 88, label: 'Hodnotím a zoraďujem...' });

  const priceKwValues = filtered.filter(l => l.price && l.power).map(l => l.price / l.power);
  const minPriceKw = priceKwValues.length > 0 ? Math.min(...priceKwValues) : null;

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
  emit('summary', { total: detailed.length, pass: filtered.length, pages: pageCount });

  scored.forEach((item, i) => {
    emit('result', { ...item, rank: i + 1 });
  });

  emit('progress', { pct: 100, label: '✅ Hotovo!' });
  emit('log', { msg: `Dokončené. ${scored.length} výsledkov.` });
}
