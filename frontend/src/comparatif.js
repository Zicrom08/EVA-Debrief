import { state } from './state.js';
import { findPlayerInGame, mostCommonName } from './format.js';
import { filteredGamesArray } from './game-filters.js';
import { aggregateGames } from './tendances.js';

// ================= COMPARATIF (classement entre tous les joueurs croisés dans les parties importées) =================
let comparatifSort = 'winrate'; // 'winrate' | 'kd' | 'n' | 'avgDmg' | 'avgScore'

// Construit le classement de tous les joueurs croisés dans les parties importées (coéquipiers et adversaires).
export function renderComparatif() {
  const container = document.getElementById('comparatifContent');
  const games = filteredGamesArray();

  if (!games.length) {
    container.innerHTML = '<div class="detail-empty">Aucune partie dans la période sélectionnée.</div>';
    return;
  }

  const uidSet = new Set();
  games.forEach(g => (g.players || []).forEach(p => uidSet.add(p.userId)));

  let rows = Array.from(uidSet).map(uid => {
    const uGames = games.filter(g => findPlayerInGame(g, uid));
    if (!uGames.length) return null;
    const agg = aggregateGames(uGames, uid);
    const rec = state.players[uid];
    const sample = findPlayerInGame(uGames[uGames.length - 1], uid);
    const name = rec ? mostCommonName(rec) : (sample ? sample.data.niceName : '?');
    return { uid, name, ...agg };
  }).filter(Boolean);

  const sorters = {
    winrate: (a,b) => b.winrate - a.winrate || b.n - a.n,
    kd: (a,b) => parseFloat(b.kd) - parseFloat(a.kd),
    n: (a,b) => b.n - a.n,
    avgDmg: (a,b) => b.avgDmg - a.avgDmg,
    avgScore: (a,b) => b.avgScore - a.avgScore,
  };
  rows = rows.sort(sorters[comparatifSort] || sorters.winrate);

  const sortLabels = { winrate:'Winrate', kd:'K/D', n:'Parties', avgDmg:'Dégâts moy.', avgScore:'Score moy.' };

  const trs = rows.map((r, i) => `
    <tr class="${r.uid == state.currentUid ? 'me' : ''}">
      <td><span class="rank-badge ${i===0?'r1':''}">${i+1}</span></td>
      <td class="name-cell">${r.name}${r.uid == state.currentUid ? ' <span style="color:var(--gold);font-size:11px;">(toi)</span>' : ''}</td>
      <td class="num">${r.n}</td>
      <td class="num"><span class="win">${r.wins}</span> / <span class="loss">${r.losses}</span></td>
      <td class="num">
        <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;">
          <div class="score-bar" style="width:50px;"><div class="a" style="width:${r.winrate}%"></div></div>
          ${r.winrate}%
        </div>
      </td>
      <td class="num ${r.kd>=1?'kd-good':'kd-bad'}">${r.kd}</td>
      <td class="num">${r.avgDmg}</td>
      <td class="num">${r.avgScore}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <div class="section-title-row">
      <div class="section-title">Comparatif entre tous les joueurs croisés</div>
      <div class="metric-toggle" id="comparatifSortToggle">
        ${Object.entries(sortLabels).map(([key,label]) =>
          `<button class="btn small ${comparatifSort===key?'active':''}" data-sort="${key}">${label}</button>`
        ).join('')}
      </div>
    </div>
    <div style="color:var(--muted);font-size:12px;margin-bottom:14px;">
      ${games.length} partie(s) sur la période · ${rows.length} joueur(s) distinct(s) (coéquipiers et adversaires croisés dans ces parties, triés par ${sortLabels[comparatifSort].toLowerCase()}).
    </div>
    <div class="table-scroll"><table class="roster">
      <thead><tr>
        <th></th><th>Joueur</th><th class="num">Parties</th><th class="num">V / D</th><th class="num">Winrate</th><th class="num">K/D</th><th class="num">Dégâts moy.</th><th class="num">Score moy.</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
  `;

  const toggle = document.getElementById('comparatifSortToggle');
  toggle.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      comparatifSort = btn.dataset.sort;
      renderComparatif();
    });
  });
}
