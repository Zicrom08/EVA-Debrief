import { state } from './state.js';
import { findPlayerInGame, mostCommonName } from './format.js';
import { filteredGamesArray } from './game-filters.js';
import { aggregateGames } from './tendances.js';
import { computeImpactScore } from './profil/compute.js';

// ================= COMPARATIF (classement entre tous les joueurs croisés dans les parties importées) =================
let comparatifSort = 'winrate'; // 'winrate' | 'kd' | 'n' | 'avgDmg' | 'avgScore' | 'impactScore'
// Nombre minimum de parties croisées pour apparaître dans le classement — sans ce seuil, un
// joueur croisé une seule fois (typique en matchmaking public) pèse autant qu'un habitué,
// noyant le classement sous des dizaines de noms croisés une fois. Même principe que le
// `minGames` de computeDuoNemesisStats (profil/compute.js), même valeur par défaut.
let comparatifMinGames = 3;

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

  const allRows = Array.from(uidSet).map(uid => {
    const uGames = games.filter(g => findPlayerInGame(g, uid));
    if (!uGames.length) return null;
    const agg = aggregateGames(uGames, uid);
    const impact = computeImpactScore(uGames, uid);
    const rec = state.players[uid];
    const sample = findPlayerInGame(uGames[uGames.length - 1], uid);
    const name = rec ? mostCommonName(rec) : (sample ? sample.data.niceName : '?');
    return { uid, name, ...agg, impactScore: impact.score };
  }).filter(Boolean);

  let rows = allRows.filter(r => r.n >= comparatifMinGames);

  const sorters = {
    winrate: (a,b) => b.winrate - a.winrate || b.n - a.n,
    kd: (a,b) => parseFloat(b.kd) - parseFloat(a.kd),
    n: (a,b) => b.n - a.n,
    avgDmg: (a,b) => b.avgDmg - a.avgDmg,
    avgScore: (a,b) => b.avgScore - a.avgScore,
    impactScore: (a,b) => b.impactScore - a.impactScore,
  };
  rows = rows.sort(sorters[comparatifSort] || sorters.winrate);

  const sortLabels = { winrate:'Winrate', kd:'K/D', n:'Parties', avgDmg:'Dégâts moy.', avgScore:'Score moy.', impactScore:"Score d'impact" };
  const minGamesOptions = [1, 2, 3, 5, 10];
  const minGamesLabel = n => n <= 1 ? 'Tous' : `≥ ${n}`;

  const minGamesToggle = `
    <div class="metric-toggle" id="comparatifMinGamesToggle" style="margin-top:6px;">
      <span style="color:var(--muted);font-size:11px;margin-right:4px;">Min. parties croisées :</span>
      ${minGamesOptions.map(n =>
        `<button class="btn small ${comparatifMinGames===n?'active':''}" data-min-games="${n}">${minGamesLabel(n)}</button>`
      ).join('')}
    </div>`;

  if (!rows.length) {
    container.innerHTML = `
      <div class="section-title-row">
        <div class="section-title">Comparatif entre tous les joueurs croisés</div>
      </div>
      ${minGamesToggle}
      <div class="detail-empty">
        ${allRows.length
          ? `Aucun joueur croisé au moins ${comparatifMinGames} fois sur cette période. Baisse le seuil ou élargis la période.`
          : 'Aucune partie exploitable dans la période sélectionnée.'}
      </div>`;
    const toggle = document.getElementById('comparatifMinGamesToggle');
    toggle.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        comparatifMinGames = Number(btn.dataset.minGames);
        renderComparatif();
      });
    });
    return;
  }

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
      <td class="num ${r.impactScore>=50?'kd-good':'kd-bad'}">${r.impactScore}</td>
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
    ${minGamesToggle}
    <div style="color:var(--muted);font-size:12px;margin:10px 0 14px;">
      ${games.length} partie(s) sur la période · ${rows.length} joueur(s) croisé(s) au moins ${comparatifMinGames} fois sur ${allRows.length} au total (coéquipiers et adversaires), triés par ${sortLabels[comparatifSort].toLowerCase()}.
    </div>
    <div class="table-scroll"><table class="roster">
      <thead><tr>
        <th></th><th>Joueur</th><th class="num">Parties</th><th class="num">V / D</th><th class="num">Winrate</th><th class="num">K/D</th><th class="num">Dégâts moy.</th><th class="num">Score moy.</th><th class="num">Score d'impact</th>
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

  const minGamesToggleEl = document.getElementById('comparatifMinGamesToggle');
  minGamesToggleEl.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      comparatifMinGames = Number(btn.dataset.minGames);
      renderComparatif();
    });
  });
}
