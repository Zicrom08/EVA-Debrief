import { state } from './state.js';
import { fmtDate, findPlayerInGame } from './format.js';
import { filteredGamesArray } from './game-filters.js';
import { buildLineChart } from './profil/charts.js';

// ================= TENDANCES (sessions / months from game history) =================
export function computeSessions(games, uid, gapMinutes) {
  const relevant = games
    .filter(g => findPlayerInGame(g, uid))
    .slice()
    .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));

  const sessions = [];
  let cur = null;
  relevant.forEach(g => {
    const start = new Date(g.createdAt).getTime();
    const end = start + ((g.data && g.data.duration) || 0) * 1000;
    if (!cur || (start - cur.lastEnd) > gapMinutes * 60 * 1000) {
      cur = { games: [], start, lastEnd: end };
      sessions.push(cur);
    }
    cur.games.push(g);
    cur.lastEnd = Math.max(cur.lastEnd, end);
  });
  return sessions;
}

// Agrège une liste de parties pour un joueur donné (V/D, K/D, dégâts moyens, score moyen).
export function aggregateGames(games, uid) {
  let wins=0, losses=0, kills=0, deaths=0, assists=0, dmg=0, score=0, n=0;
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p) return;
    n++;
    if (p.data.outcome === 'Victory') wins++;
    else if (p.data.outcome === 'Defeat') losses++;
    kills += p.data.kills || 0;
    deaths += p.data.deaths || 0;
    assists += p.data.assists || 0;
    dmg += p.data.inflictedDamage || 0;
    score += p.data.score || 0;
  });
  return {
    n, wins, losses,
    winrate: n ? Math.round((wins/n)*100) : 0,
    kd: deaths ? (kills/deaths).toFixed(2) : kills.toFixed(2),
    kda: deaths ? ((kills+assists)/deaths).toFixed(2) : (kills+assists).toFixed(2),
    avgDmg: n ? Math.round(dmg/n) : 0,
    avgScore: n ? Math.round(score/n) : 0,
    kills, deaths, assists,
  };
}

// Construit les 4 graphiques d'évolution de l'onglet Tendances (taux de victoire, K/D,
// dégâts moyens, score moyen) à partir des lignes déjà agrégées par séance/mois (voir
// renderTrends) — `rows` y est trié du plus récent au plus ancien pour le tableau, donc on
// le parcourt à l'envers ici pour afficher les courbes chronologiquement (gauche = plus
// ancien), comme le graphique de progression du Profil (voir buildTrendChart). Moins de 2
// points ne permet pas de tracer une courbe utile — on affiche un message à la place plutôt
// qu'un graphique dégénéré (même garde que renderMapDeepDive côté analytics-view.js).
function buildTrendCharts(rows) {
  const chrono = rows.slice().reverse();
  const unit = state.trendMode === 'session' ? 'séance' : 'mois';
  const tooFew = '<div class="hl-empty">Pas assez de données pour une courbe (2 minimum).</div>';

  const winrateVals = chrono.map(r => r.agg.winrate);
  const kdVals = chrono.map(r => Number(r.agg.kd));
  const dmgVals = chrono.map(r => r.agg.avgDmg);
  const scoreVals = chrono.map(r => r.agg.avgScore);

  const winrateChart = winrateVals.length >= 2 ? buildLineChart(winrateVals, {
    color: 'var(--win)', yMin: 0, yMax: 100, unit: '%', decimals: 0, pixelHeight: 130,
    refValue: 50, refLabel: '50% (équilibre)', fill: true,
    legendLabel: `Taux de victoire par ${unit}`,
  }) : tooFew;

  const kdChart = kdVals.length >= 2 ? buildLineChart(kdVals, {
    color: 'var(--gold)', yMin: 0, decimals: 2, pixelHeight: 130, fill: true,
    refValue: 1, refLabel: '1.00',
    legendLabel: `Ratio K/D par ${unit}`,
  }) : tooFew;

  const dmgChart = dmgVals.length >= 2 ? buildLineChart(dmgVals, {
    color: 'var(--rebels)', yMin: 0, pixelHeight: 130, fill: true,
    legendLabel: `Dégâts moyens par ${unit}`,
  }) : tooFew;

  const scoreChart = scoreVals.length >= 2 ? buildLineChart(scoreVals, {
    color: 'var(--alliance)', yMin: 0, pixelHeight: 130, fill: true,
    legendLabel: `Score moyen par ${unit}`,
  }) : tooFew;

  return `
    <div class="analytics-grid-2">
      <div>
        <div class="section-title">Évolution du taux de victoire</div>
        <div class="chart-card">${winrateChart}</div>
      </div>
      <div>
        <div class="section-title">Évolution du ratio K/D</div>
        <div class="chart-card">${kdChart}</div>
      </div>
    </div>
    <div class="analytics-grid-2">
      <div>
        <div class="section-title">Évolution des dégâts moyens</div>
        <div class="chart-card">${dmgChart}</div>
      </div>
      <div>
        <div class="section-title">Évolution du score moyen</div>
        <div class="chart-card">${scoreChart}</div>
      </div>
    </div>`;
}

// Construit l'onglet Tendances (agrégats par séance de jeu ou par mois, sous forme de
// graphiques d'évolution puis de tableau détaillé).
export function renderTrends() {
  const wrap = document.getElementById('trendTableWrap');
  const chartsWrap = document.getElementById('trendCharts');
  const uid = state.currentUid;
  const games = filteredGamesArray();

  if (!uid || !games.some(g => findPlayerInGame(g, uid))) {
    wrap.innerHTML = '<div class="detail-empty">Aucune partie dans la période sélectionnée pour ce joueur.</div>';
    if (chartsWrap) chartsWrap.innerHTML = '';
    return;
  }

  let rows = [];
  if (state.trendMode === 'session') {
    const sessions = computeSessions(games, uid, 45).sort((a,b) => b.start - a.start);
    rows = sessions.map(s => {
      const agg = aggregateGames(s.games, uid);
      const durationMin = Math.round((s.lastEnd - s.start) / 60000);
      return { label: fmtDate(new Date(s.start).toISOString()), sub: `${durationMin} min de jeu`, agg };
    });
  } else {
    const byMonth = {};
    games.forEach(g => {
      if (!findPlayerInGame(g, uid)) return;
      const d = new Date(g.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (!byMonth[key]) byMonth[key] = [];
      byMonth[key].push(g);
    });
    rows = Object.entries(byMonth)
      .sort((a,b) => b[0].localeCompare(a[0]))
      .map(([key, gs]) => {
        const d = new Date(key + '-01');
        const label = d.toLocaleDateString('fr-FR', { month:'long', year:'numeric' });
        return { label: label.charAt(0).toUpperCase()+label.slice(1), sub: '', agg: aggregateGames(gs, uid) };
      });
  }

  const trs = rows.map(r => `
    <tr>
      <td class="name-cell">${r.label}${r.sub ? `<div style="color:var(--muted);font-size:11px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;">${r.sub}</div>` : ''}</td>
      <td class="num">${r.agg.n}</td>
      <td class="num"><span class="win">${r.agg.wins}</span> / <span class="loss">${r.agg.losses}</span></td>
      <td class="num">
        <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;">
          <div class="score-bar" style="width:60px;"><div class="a" style="width:${r.agg.winrate}%"></div></div>
          ${r.agg.winrate}%
        </div>
      </td>
      <td class="num ${r.agg.kd>=1?'kd-good':'kd-bad'}">${r.agg.kd}</td>
      <td class="num">${r.agg.avgDmg}</td>
      <td class="num">${r.agg.avgScore}</td>
    </tr>
  `).join('');

  if (chartsWrap) chartsWrap.innerHTML = buildTrendCharts(rows);

  wrap.innerHTML = `
    <div class="table-scroll"><table class="roster">
      <thead><tr>
        <th>${state.trendMode === 'session' ? 'Séance' : 'Mois'}</th>
        <th class="num">Parties</th><th class="num">V / D</th><th class="num">Winrate</th><th class="num">K/D</th><th class="num">Dégâts moy.</th><th class="num">Score moy.</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
  `;
}
