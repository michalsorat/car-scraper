function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fuelClass(fuel) {
  if (!fuel) return '';
  const f = fuel.toLowerCase();
  if (/plug[- ]?in|phev/.test(f)) return 'fuel-plugin';
  if (/hybrid/.test(f))           return 'fuel-hybrid';
  if (/benz/.test(f))             return 'fuel-benzin';
  if (/elektr/.test(f))           return 'fuel-elektro';
  if (/diesel|nafta/.test(f))     return 'fuel-diesel';
  return '';
}

function fuelEmoji(fuel) {
  if (!fuel) return '❓';
  const f = fuel.toLowerCase();
  if (/plug[- ]?in|phev/.test(f)) return '🔌';
  if (/hybrid/.test(f))           return '♻️';
  if (/benz/.test(f))             return '⛽';
  if (/elektr/.test(f))           return '⚡';
  if (/diesel|nafta/.test(f))     return '🛢️';
  return '❓';
}

function scoreRingColor(score) {
  if (score >= 70) return '#22c55e';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

function renderCard(item) {
  const r = 20, c = 2 * Math.PI * r;
  const color = scoreRingColor(item.totalScore);
  const dash = (item.totalScore / 100) * c;
  const priceKw = item.price && item.power ? (item.price / item.power).toFixed(1) : '—';
  const warnings = [];
  if (!item.power)   warnings.push('výkon sa nepodarilo zistiť');
  if (item.mileage == null) warnings.push('nájazd sa nepodarilo zistiť');
  if (!item.year)    warnings.push('rok výroby sa nepodarilo zistiť');
  if (!item.fuel)    warnings.push('druh paliva sa nepodarilo zistiť');
  const fuelLabel = item.fuel || 'Neuvedené';

  return `
  <div class="car-card">
    <div class="car-card-header">
      <div class="rank-score">
        <div class="rank">#${item.rank}</div>
        <div class="score-ring">
          <svg width="52" height="52" viewBox="0 0 52 52">
            <circle cx="26" cy="26" r="${r}" fill="none" stroke="#2d3250" stroke-width="5"/>
            <circle cx="26" cy="26" r="${r}" fill="none" stroke="${color}" stroke-width="5"
              stroke-dasharray="${dash.toFixed(1)} ${(c - dash).toFixed(1)}"
              stroke-linecap="round"/>
          </svg>
          <div class="score-text">${item.totalScore}</div>
        </div>
      </div>
      <div class="car-title-area">
        <div class="car-title">
          <a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.title)}</a>
        </div>
      </div>
      <div class="car-price">${item.price ? Number(item.price).toLocaleString('sk-SK') + ' €' : '—'}</div>
    </div>
    <div class="car-card-body">
      <div class="car-specs">
        <div class="spec-tag ${fuelClass(item.fuel)}">
          <span class="icon">${fuelEmoji(item.fuel)}</span>
          <span class="val">${esc(fuelLabel)}</span>
        </div>
        <div class="spec-tag">
          <span class="icon">⚡</span>
          <span class="val">${item.power ? item.power + ' kW' : '—'}</span>
          <span class="lbl">výkon</span>
        </div>
        <div class="spec-tag">
          <span class="icon">📍</span>
          <span class="val">${item.mileage != null ? Number(item.mileage).toLocaleString('sk-SK') + ' km' : '—'}</span>
          <span class="lbl">nájazd</span>
        </div>
        <div class="spec-tag">
          <span class="icon">📅</span>
          <span class="val">${item.year || '—'}</span>
          <span class="lbl">rok</span>
        </div>
      </div>
      <div class="score-breakdown">
        <div class="score-part"><span class="pts">${item.scores.fuel}/20</span> <span class="cat">palivo</span></div>
        <div class="score-part"><span class="pts">${item.scores.power}/25</span> <span class="cat">výkon</span></div>
        <div class="score-part"><span class="pts">${item.scores.mileage}/25</span> <span class="cat">nájazd</span></div>
        <div class="score-part"><span class="pts">${item.scores.priceKw}/20</span> <span class="cat">cena/kW</span></div>
        <div class="score-part"><span class="pts">${item.scores.year}/10</span> <span class="cat">rok</span></div>
      </div>
      ${item.description ? `<div class="car-desc">${esc(item.description.substring(0, 200))}${item.description.length > 200 ? '…' : ''}</div>` : ''}
      ${warnings.length ? `<div class="warning">⚠️ Poznámka: ${warnings.join(', ')}</div>` : ''}
    </div>
  </div>`;
}

export function generateResultsHTML(results, { totalScanned, totalPages, scanDate }) {
  const cards = results.map(item => renderCard(item)).join('');
  const dateStr = scanDate.toLocaleDateString('sk-SK', { day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = scanDate.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });

  return `<!DOCTYPE html>
<html lang="sk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bazos Auto Skener – ${dateStr} ${timeStr}</title>
  <style>
    :root {
      --bg: #0f1117; --card: #1a1d27; --card2: #22263a;
      --accent: #4f8ef7; --accent2: #7c3aed;
      --green: #22c55e; --yellow: #f59e0b; --red: #ef4444;
      --text: #e8eaf6; --muted: #8892b0; --border: #2d3250; --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; min-height: 100vh; }
    .header {
      background: linear-gradient(135deg, #1a1d27 0%, #22263a 100%);
      border-bottom: 1px solid var(--border);
      padding: 24px 32px;
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;
    }
    .header-left h1 {
      font-size: 1.6rem; font-weight: 700;
      background: linear-gradient(90deg, var(--accent), var(--accent2));
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .header-left p { color: var(--muted); font-size: 0.85rem; margin-top: 4px; }
    .date-badge { background: var(--card2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 16px; font-size: 0.85rem; color: var(--muted); }
    .date-badge span { color: var(--accent); font-weight: 600; }
    .main { max-width: 960px; margin: 0 auto; padding: 32px 16px; }
    .summary-banner {
      background: var(--card2); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 16px 24px; margin-bottom: 24px;
      display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
    }
    .summary-stat { text-align: center; }
    .summary-stat .val { font-size: 1.8rem; font-weight: 700; color: var(--accent); line-height: 1; }
    .summary-stat .lbl { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
    .summary-divider { width: 1px; height: 40px; background: var(--border); }
    .results-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .results-header h2 { font-size: 1rem; font-weight: 600; color: var(--muted); }
    .car-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 16px; overflow: hidden; transition: border-color 0.2s; }
    .car-card:hover { border-color: var(--accent); }
    .car-card-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px 12px; gap: 12px; }
    .rank-score { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .rank { font-size: 0.8rem; font-weight: 700; color: var(--muted); width: 28px; }
    .score-ring { position: relative; width: 52px; height: 52px; flex-shrink: 0; }
    .score-ring svg { position: absolute; top: 0; left: 0; transform: rotate(-90deg); }
    .score-ring .score-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 0.75rem; font-weight: 700; color: var(--text); }
    .car-title-area { flex: 1; min-width: 0; }
    .car-title { font-size: 0.97rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .car-title a { color: inherit; text-decoration: none; }
    .car-title a:hover { color: var(--accent); }
    .car-price { font-size: 1.1rem; font-weight: 700; color: var(--green); flex-shrink: 0; }
    .car-card-body { padding: 0 20px 16px; }
    .car-specs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    .spec-tag { background: var(--card2); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 0.78rem; display: flex; align-items: center; gap: 5px; }
    .spec-tag .icon { font-size: 0.85rem; }
    .spec-tag .val { color: var(--text); font-weight: 500; }
    .spec-tag .lbl { color: var(--muted); }
    .score-breakdown { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
    .score-part { background: var(--card2); border-radius: 4px; padding: 3px 8px; font-size: 0.72rem; }
    .score-part .pts { color: var(--accent); font-weight: 600; }
    .score-part .cat { color: var(--muted); }
    .car-desc { font-size: 0.78rem; color: var(--muted); line-height: 1.5; border-top: 1px solid var(--border); padding-top: 10px; margin-top: 4px; }
    .warning { font-size: 0.75rem; color: var(--yellow); margin-top: 6px; }
    .fuel-benzin { border-color: #f59e0b40; color: #f59e0b; }
    .fuel-hybrid { border-color: #22c55e40; color: #22c55e; }
    .fuel-plugin { border-color: #60a5fa40; color: #60a5fa; }
    .fuel-elektro { border-color: #a78bfa40; color: #a78bfa; }
    .fuel-diesel { border-color: #ef444440; color: #ef4444; }
    .no-results { text-align: center; padding: 48px; color: var(--muted); }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>
<div class="header">
  <div class="header-left">
    <h1>🚗 Bazos Auto Skener</h1>
    <p>Uložené výsledky</p>
  </div>
  <div class="date-badge">Sken: <span>${esc(dateStr)} ${esc(timeStr)}</span></div>
</div>
<div class="main">
  <div class="summary-banner">
    <div class="summary-stat"><div class="val">${totalScanned}</div><div class="lbl">Inzerátov prehľadaných</div></div>
    <div class="summary-divider"></div>
    <div class="summary-stat"><div class="val">${results.length}</div><div class="lbl">Prešlo filtrom</div></div>
    <div class="summary-divider"></div>
    <div class="summary-stat"><div class="val">${totalPages}</div><div class="lbl">Stránok</div></div>
  </div>
  <div class="results-header">
    <h2>Celkom ${totalScanned} inzerátov, ${results.length} prešlo filtrom</h2>
  </div>
  ${results.length > 0 ? cards : '<div class="no-results"><div>Žiadny inzerát nepresiel filtrom.</div></div>'}
</div>
</body>
</html>`;
}
