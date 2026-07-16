import { state } from './state.js';
import { fmtDate, findPlayerInGame } from './format.js';
import { filteredGamesArray } from './game-filters.js';

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
    const end = start + (g.data.duration || 0) * 1000;
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
    avgDmg: n ? Math.round(dmg/n) : 0,
    avgScore: n ? Math.round(score/n) : 0,
    kills, deaths, assists,
  };
}

// Construit l'onglet Tendances (agrégats par séance de jeu ou par mois).
export function renderTrends() {
  const wrap = document.getElementById('trendTableWrap');
  const uid = state.currentUid;
  const games = filteredGamesArray();

  if (!uid || !games.some(g => findPlayerInGame(g, uid))) {
    wrap.innerHTML = '<div class="detail-empty">Aucune partie dans la période sélectionnée pour ce joueur.</div>';
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
