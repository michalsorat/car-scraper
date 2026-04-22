import { parse } from 'node-html-parser';
import { getListing, insertListing, updatePrice } from './db.js';

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
//  EXTRACT CAR PARAMS  (tabuľka + celý text)
// ─────────────────────────────────────────────
function extractCarParams(html) {
  const doc = parse(html);
  doc.querySelectorAll('script, style, noscript, iframe, head').forEach(el => el.remove());

  const mainEl =
    doc.querySelector('.listainzeratu') ||
    doc.querySelector('#inzerat') ||
    doc.querySelector('.inzeratydetail') ||
    doc.querySelector('body') ||
    doc;

  // Popis pre zobrazenie (krátky)
  const descEl = mainEl.querySelector('.popis') || mainEl.querySelector('#popis') ||
                 mainEl.querySelector('.textpodsekce') || mainEl.querySelector('.reklamni_box');
  const description = (descEl ? descEl.text : '').replace(/\s+/g, ' ').trim().substring(0, 300);

  // Štruktúrované riadky tabuľky parametrov (kľúč: hodnota) — najpresnejší zdroj
  const lines = [];
  for (const row of mainEl.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('td, th');
    if (cells.length >= 2) {
      const key = cells[0].text.trim().replace(/:$/, '');
      const val = cells[1].text.trim();
      if (key && val) lines.push(`${key}: ${val}`);
    }
  }
  // Fallback: definition listy
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

  // Celý text stránky — fallback keď tabuľka chýba alebo je neúplná
  const bodyText = mainEl.text.replace(/\s+/g, ' ').trim().substring(0, 1500);

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
//  REGEX EXTRAKCIA  (názov + tabuľka parametrov)
// ─────────────────────────────────────────────
function regexExtract(title, params, bodyText = '') {
  // src = názov + tabuľka + celý text (pre výkon, rok, palivo)
  // nájazd hľadáme ZÁMERNÉ iba v tabuľke a názve — bodyText obsahuje šum
  const src = `${title}\n${params}\n${bodyText}`;

  // ── Výkon ──
  let power = null;
  // "150kW", "150 kW", "150KW" — min 2 číslice aby sme nechytili napr. "5kW"
  let m = src.match(/\b(\d{2,3}(?:[.,]\d)?)\s*[kK][wW]\b/);
  if (m) power = Math.round(parseFloat(m[1].replace(',', '.')));
  // "204PS", "204 PS", "204hp", "204 hp", "204cv"
  if (!power) {
    m = src.match(/\b(\d{2,3}(?:[.,]\d)?)\s*(?:PS|HP|hp|cv|CV)\b/);
    if (m) power = Math.round(parseFloat(m[1].replace(',', '.')) * 0.7355);
  }

  // ── Nájazd ──
  // POZOR: chceme len skutočný nájazd (km), nie "5000km servis", "každých 10000km" atď.
  // Preto hľadáme len v riadkoch tabuľky kde kľúč obsahuje "najazdené/nájazd/km/tachometer"
  let mileage = null;
  const mileageLineMatch = params.match(
    /(?:najazdené|nájazd|km|tachometer|počet\s*km)[^\n]*?:\s*([0-9][0-9 .]{2,})\s*km/i
  );
  if (mileageLineMatch) {
    mileage = parseInt(mileageLineMatch[1].replace(/[ .]/g, ''));
  }
  // Fallback na názov: "85000km", "85 000 km", "85.000km" — min 5 číslic
  if (!mileage) {
    m = title.match(/\b(\d{1,3})[. ]?(\d{3})\s*km\b/i);
    if (m) mileage = parseInt(m[1] + m[2]);
  }
  // "85tkm", "85tis" v názve
  if (!mileage) {
    m = title.match(/\b(\d{2,3})\s*t(?:is\.?|km)\b/i);
    if (m) mileage = parseInt(m[1]) * 1000;
  }

  // ── Rok výroby ──
  let year = null;
  // Najprv hľadáme v tabuľke: riadok s "rok" alebo "r.v." alebo "výroba"
  const yearLineMatch = params.match(
    /(?:rok[^\n]*?výrob|rok[^\n]*?registr|r\.?\s*v\.?)[^\n]*?:\s*(20[1-2]\d)\b/i
  );
  if (yearLineMatch) {
    year = parseInt(yearLineMatch[1]);
  }
  // Fallback: akékoľvek 4-ciferné číslo 2015–2029 v celom texte
  if (!year) {
    m = src.match(/\b(20(?:1[5-9]|2[0-9]))\b/);
    if (m) year = parseInt(m[1]);
  }

  // ── Palivo ──
  let fuel = null;
  const tl = src.toLowerCase();
  // Poradie je dôležité — špecifickejšie pred všeobecnejším
  if (/plug.?in|phev/.test(tl))                                          fuel = 'Plug-in hybrid';
  else if (/mild.?hybrid/.test(tl))                                      fuel = 'Hybrid';
  else if (/hybrid/.test(tl))                                            fuel = 'Hybrid';
  else if (/elektr|e-tron|e-golf|ioniq|bev|\bid\.?\d|\bev\b/.test(tl))  fuel = 'Elektro';
  else if (/diesel|nafta|\btdi\b|\bcdi\b|\bhdi\b|\bdci\b|\bcrdi\b|\bjtd\b|\bd4\b|\bd5\b/.test(tl)) fuel = 'Diesel';
  else if (/benz[ií]n|benzin|\btsi\b|\btfsi\b|\bgdi\b|\bt-gdi\b|\bmpi\b|\bgti\b|\bgsi\b/.test(tl)) fuel = 'Benzín';

  return { power, mileage, year, fuel };
}

// ─────────────────────────────────────────────
//  OLLAMA  —  AI extrakcia všetkých polí
// ─────────────────────────────────────────────
async function extractCarData(title, params, bodyText, emitLog) {
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
//  SCORING EXPORT  (pre DB view)
// ─────────────────────────────────────────────
export function scoreListings(listings) {
  const filtered = listings.filter(l =>
    l.power >= 110 &&
    l.mileage !== null && l.mileage <= 100000 &&
    l.year >= 2021
  );
  const priceKwValues = filtered.filter(l => l.price && l.power).map(l => l.price / l.power);
  const minPriceKw    = priceKwValues.length > 0 ? Math.min(...priceKwValues) : null;
  const scored = filtered.map(l => {
    const priceKwRatio = (l.price && l.power) ? l.price / l.power : null;
    const scores = {
      fuel:    scoreFuel(l.fuel),
      power:   scorePower(l.power),
      mileage: scoreMileage(l.mileage),
      priceKw: scorePriceKw(priceKwRatio, minPriceKw),
      year:    scoreYear(l.year),
    };
    return { ...l, scores, totalScore: scores.fuel + scores.power + scores.mileage + scores.priceKw + scores.year, priceKwRatio };
  });
  scored.sort((a, b) => b.totalScore - a.totalScore);
  return scored.map((item, i) => ({ ...item, rank: i + 1 }));
}

// ─────────────────────────────────────────────
//  MAIN SCRAPER
// ─────────────────────────────────────────────
export async function runScraper(emit, isAborted, maxPages = 0) {
  emit('log', { msg: `✅ Ollama (model: ${OLLAMA_MODEL})` });

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

  // ── Phase 2a: Rozdeliť na cached vs. nové ──
  emit('progress', { pct: 30, label: 'Kontrolujem cache...' });
  let newCount    = 0;
  let cachedCount = 0;
  const detailed  = [];
  const toFetch   = [];   // nové inzeráty čakajúce na fetch + Ollama

  for (const listing of uniqueListings) {
    const bazosId  = extractBazosId(listing.url);
    const existing = bazosId ? getListing(bazosId) : null;
    if (existing) {
      if (existing.price !== listing.price && listing.price != null) {
        updatePrice(bazosId, listing.price);
        emit('log', { msg: `💰 Zmena ceny: ${existing.title?.substring(0, 40)} → ${listing.price} €` });
      }
      cachedCount++;
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
    } else {
      toFetch.push({ listing, bazosId });
    }
  }
  emit('log', { msg: `Cache: ${cachedCount}, nové na spracovanie: ${toFetch.length}` });

  // ── Phase 2b: Fetch HTML paralelne (max 5) ──
  if (toFetch.length > 0) {
    emit('progress', { pct: 35, label: `Sťahujem ${toFetch.length} detailových stránok...` });

    const fetched = await withConcurrency(toFetch, 5, async ({ listing, bazosId }, i) => {
      if (isAborted()) return null;
      emit('progress', {
        pct: 35 + Math.round((i / toFetch.length) * 20),
        label: `Fetch ${i + 1}/${toFetch.length}: ${listing.title.substring(0, 40)}...`,
      });
      try {
        const html                                    = await fetchHTML(listing.url);
        const { description, params, bodyText }     = extractCarParams(html);
        return { listing, bazosId, description, params, bodyText };
      } catch (e) {
        emit('log', { msg: `   ⚠️ Fetch chyba: ${listing.title.substring(0, 40)} — ${e.message}` });
        return null;
      }
    });

    // ── Phase 2c: Ollama sekvenčne (GPU zvládne iba 1) ──
    emit('progress', { pct: 55, label: 'AI parsovanie...' });
    const valid = fetched.filter(Boolean);

    for (let i = 0; i < valid.length; i++) {
      if (isAborted()) break;
      const { listing, bazosId, description, params, bodyText } = valid[i];
      emit('progress', {
        pct: 55 + Math.round((i / valid.length) * 30),
        label: `AI ${i + 1}/${valid.length}: ${listing.title.substring(0, 40)}...`,
      });
      emit('log', { msg: `🆕 Nový: ${listing.title.substring(0, 50)}` });

      try {
        const aiData = await extractCarData(listing.title, params, bodyText, msg => emit('log', { msg }));
        emit('log', { msg: `   → výkon: ${aiData.power ?? '?'} kW | nájazd: ${aiData.mileage ?? '?'} km | rok: ${aiData.year ?? '?'} | palivo: ${aiData.fuel ?? '?'}` });

        const fullListing = { title: listing.title, url: listing.url, price: listing.price, description, ...aiData };
        if (bazosId) insertListing({ bazos_id: bazosId, ...fullListing, ai_parsed: 1 });

        detailed.push(fullListing);
        newCount++;
      } catch (e) {
        emit('log', { msg: `   ⚠️ AI chyba: ${e.message}` });
        detailed.push({ ...listing, year: null, mileage: null, power: null, fuel: null, description });
      }
    }
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
