import { state } from '../state.js';
import { niceNum, fmtDateShort } from '../format.js';

// ---- rendu SVG (pas de dépendance externe, tout est généré ici) ----
export function buildLineChart(values, opts) {
  opts = opts || {};
  const w = 640, h = opts.pixelHeight ? Math.min(170, opts.pixelHeight) : 120;
  const padLeft = 36, padRight = 10, padTop = 10, padBottom = 10;
  if (!values.length) return '<div class="hl-empty">Pas assez de données</div>';
  const yMin = opts.yMin != null ? opts.yMin : Math.min(...values);
  const yMax = opts.yMax != null ? opts.yMax : Math.max(...values);
  const range = (yMax - yMin) || 1;
  const n = values.length;
  const innerW = w - padLeft - padRight;
  const innerH = h - padTop - padBottom;
  const stepX = n > 1 ? innerW / (n - 1) : 0;
  const toY = v => padTop + innerH - ((v - yMin) / range) * innerH;
  const pts = values.map((v, i) => [padLeft + i * stepX, toY(v)]);
  const linePath = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const areaPath = linePath + ` L ${pts[pts.length-1][0].toFixed(1)},${(padTop+innerH).toFixed(1)} L ${pts[0][0].toFixed(1)},${(padTop+innerH).toFixed(1)} Z`;
  const color = opts.color || 'var(--alliance)';
  const unit = opts.unit || '';
  const decimals = opts.decimals != null ? opts.decimals : 0;

  const tickCount = 4;
  let ticksSvg = '';
  for (let i = 0; i <= tickCount; i++) {
    const frac = i / tickCount;
    const val = yMin + frac * range;
    const y = padTop + innerH - frac * innerH;
    ticksSvg += `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${w-padRight}" y2="${y.toFixed(1)}" style="stroke:var(--line);stroke-width:1" />`;
    ticksSvg += `<text x="${(padLeft-6).toFixed(1)}" y="${(y+3).toFixed(1)}" text-anchor="end" style="font-size:9px;fill:var(--muted);font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace;">${val.toFixed(decimals)}${unit}</text>`;
  }

  let refLine = '';
  if (opts.refValue != null && opts.refValue >= yMin && opts.refValue <= yMax) {
    const ry = toY(opts.refValue);
    refLine = `<line x1="${padLeft}" y1="${ry.toFixed(1)}" x2="${w-padRight}" y2="${ry.toFixed(1)}" style="stroke:var(--muted);stroke-width:1;stroke-dasharray:4,3;opacity:0.7" />
      <text x="${(w-padRight).toFixed(1)}" y="${(ry-4).toFixed(1)}" text-anchor="end" style="font-size:9px;fill:var(--muted);">${opts.refLabel || ''}</text>`;
  }

  const gradId = 'grad' + Math.random().toString(36).slice(2, 9);
  const areaFill = opts.fill === false ? '' : `
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style="stop-color:${color};stop-opacity:0.25" />
      <stop offset="100%" style="stop-color:${color};stop-opacity:0" />
    </linearGradient></defs>
    <path d="${areaPath}" style="fill:url(#${gradId});stroke:none" />`;

  const lastVal = values[values.length - 1];
  const avgVal = values.reduce((a,b) => a+b, 0) / values.length;
  const minVal = Math.min(...values), maxVal = Math.max(...values);
  const legend = `
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:8px;flex-wrap:wrap;gap:6px;">
      <span><span style="color:${color};">●</span> ${opts.legendLabel || ''}</span>
      <span>actuel <strong style="color:var(--text);">${lastVal.toFixed(decimals)}${unit}</strong>
        · moyenne ${avgVal.toFixed(decimals)}${unit}
        · min ${minVal.toFixed(decimals)}${unit} · max ${maxVal.toFixed(decimals)}${unit}</span>
    </div>`;

  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${opts.pixelHeight||120}px;overflow:visible;">
    ${ticksSvg}
    ${refLine}
    ${areaFill}
    <path d="${linePath}" style="fill:none;stroke:${color};stroke-width:2;stroke-linejoin:round;stroke-linecap:round" />
  </svg>${legend}`;
}

// Génère le SVG du graphique de progression (valeur brute en fond + moyenne glissante en avant-plan).
export function buildTrendChart(raw, avg, unitLabel) {
  const w = 640, h = 160, padLeft = 34, padRight = 10, padTop = 10, padBottom = 10;
  const allVals = raw.concat(avg);
  const yMin = Math.min(...allVals, 0);
  const yMax = Math.max(...allVals) || 1;
  const range = (yMax - yMin) || 1;
  const n = raw.length;
  const innerW = w - padLeft - padRight;
  const innerH = h - padTop - padBottom;
  const stepX = n > 1 ? innerW / (n-1) : 0;
  const toPts = vals => vals.map((v,i) => [padLeft + i*stepX, padTop + innerH - ((v - yMin)/range) * innerH]);
  const rawPts = toPts(raw), avgPts = toPts(avg);
  const rawPath = rawPts.map((p,i) => (i===0?'M':'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const avgPath = avgPts.map((p,i) => (i===0?'M':'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const areaPath = rawPath + ` L ${rawPts[rawPts.length-1][0].toFixed(1)},${(padTop+innerH).toFixed(1)} L ${rawPts[0][0].toFixed(1)},${(padTop+innerH).toFixed(1)} Z`;
  const tickCount = 4;
  let ticksSvg = '';
  for (let i = 0; i <= tickCount; i++) {
    const frac = i / tickCount;
    const val = yMin + frac * range;
    const y = padTop + innerH - frac * innerH;
    ticksSvg += `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${w-padRight}" y2="${y.toFixed(1)}" style="stroke:var(--line);stroke-width:1" />`;
    ticksSvg += `<text x="${(padLeft-6).toFixed(1)}" y="${(y+3).toFixed(1)}" text-anchor="end" style="font-size:9px;fill:var(--muted);font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace;">${niceNum(val)}</text>`;
  }
  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:180px;overflow:visible;">
      ${ticksSvg}
      <path d="${areaPath}" style="fill:var(--alliance);opacity:0.08;stroke:none" />
      <path d="${rawPath}" style="fill:none;stroke:var(--alliance);stroke-width:1.2;opacity:0.5" />
      <path d="${avgPath}" style="fill:none;stroke:var(--gold);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round" />
    </svg>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:8px;flex-wrap:wrap;gap:6px;">
      <span>${n} partie(s) · max ${niceNum(yMax)} · min ${niceNum(yMin)} ${unitLabel||''}</span>
      <span><span style="color:var(--alliance);">●</span> par partie &nbsp; <span style="color:var(--gold);">●</span> moyenne glissante</span>
    </div>`;
}

// Construit une ligne de barre de progression simple (utilisé pour carte/mode/jour/moment de la journée).
export function barRow(label, pct, sublabel) {
  const p = pct == null ? 0 : pct;
  return `
    <div class="bar-row">
      <div class="bar-row-top"><span class="bar-row-label">${label}</span><span class="bar-row-pct">${pct==null?'—':p+'%'}</span></div>
      <div class="score-bar" style="height:7px;"><div class="a" style="width:${p}%"></div></div>
      <div class="bar-row-sub">${sublabel}</div>
    </div>`;
}

// Comme barRow, mais cliquable — utilisé pour "Performance par carte" afin de pouvoir
// ouvrir un focus dédié sur une carte (voir state.mapDeepDiveSelection / renderMapDeepDive).
export function mapBarRow(label, pct, sublabel) {
  const p = pct == null ? 0 : pct;
  const selected = state.mapDeepDiveSelection === label;
  return `
    <div class="bar-row bar-row-clickable ${selected?'selected':''}" data-map-select="${label}">
      <div class="bar-row-top"><span class="bar-row-label">${label}</span><span class="bar-row-pct">${pct==null?'—':p+'%'}</span></div>
      <div class="score-bar" style="height:7px;"><div class="a" style="width:${p}%"></div></div>
      <div class="bar-row-sub">${sublabel}</div>
    </div>`;
}

// Construit une ligne d'histogramme (répartition par tranche, ex: distribution de K/D).
export function distRow(label, n, maxN) {
  const pct = maxN ? Math.round((n / maxN) * 100) : 0;
  return `
    <div class="bar-row">
      <div class="bar-row-top"><span class="bar-row-label">${label}</span><span class="bar-row-pct">${n} partie(s)</span></div>
      <div class="score-bar" style="height:7px;"><div class="a" style="width:${pct}%"></div></div>
    </div>`;
}

// Construit une carte de mise en avant (meilleure/pire partie sur une statistique donnée).
export function highlightCard(title, entry, formatter, color) {
  if (!entry) return `<div class="highlight-card"><div class="hl-title">${title}</div><div class="hl-empty">Pas assez de données</div></div>`;
  const g = entry.game, p = entry.player;
  return `
    <div class="highlight-card">
      <div class="hl-title">${title}</div>
      <div class="hl-value" style="color:${color}">${formatter(entry)}</div>
      <div class="hl-sub">${(g.map && g.map.name) || '?'} · ${fmtDateShort(g.createdAt)}</div>
      <div class="hl-detail">${p.data.kills}K / ${p.data.deaths}D · ${(p.data.inflictedDamage||0).toLocaleString('fr-FR')} dmg</div>
    </div>`;
}
