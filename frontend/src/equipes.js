import { state } from './state.js';
import { findPlayerInGame, mostCommonName } from './format.js';
import { filteredGamesArray } from './game-filters.js';
import { apiGet, apiSend } from './api.js';
import { persistUiPrefs } from './ui-prefs.js';
import { canonicalUid } from './player-links.js';

// ================= ÉQUIPES (groupes de joueurs créés manuellement) =================
function teamId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Liste tous les joueurs connus (au moins une partie importée), triés par nombre de parties.
function allKnownPlayers() {
  // joueurs vus dans l'historique (avec au moins une partie) + ceux qui n'ont que des stats de profil
  return Object.entries(state.players).map(([uid, rec]) => ({ uid, name: mostCommonName(rec), games: rec.games }));
}

// Agrège les stats de tous les membres d'une équipe personnalisée sur les parties filtrées.
export function computeTeamAggregate(memberUids, games) {
  let n = 0, wins = 0, losses = 0, kills = 0, deaths = 0, assists = 0, dmgSum = 0, scoreSum = 0;
  const perMember = [];
  const distinctGameIds = new Set();
  memberUids.forEach(uid => {
    const myGames = games.filter(g => findPlayerInGame(g, uid));
    let mN=0, mWins=0, mLosses=0, mKills=0, mDeaths=0, mAssists=0, mDmg=0, mScore=0;
    myGames.forEach(g => {
      const p = findPlayerInGame(g, uid);
      mN++; distinctGameIds.add(g.id);
      if (p.data.outcome === 'Victory') mWins++;
      else if (p.data.outcome === 'Defeat') mLosses++;
      mKills += p.data.kills || 0; mDeaths += p.data.deaths || 0; mAssists += p.data.assists || 0;
      mDmg += p.data.inflictedDamage || 0; mScore += p.data.score || 0;
    });
    n += mN; wins += mWins; losses += mLosses; kills += mKills; deaths += mDeaths; assists += mAssists;
    dmgSum += mDmg; scoreSum += mScore;
    // canonicalUid() : les équipes créées avant une fusion peuvent encore lister un
    // alias directement (state.players n'est indexé, lui, que par identifiant canonique).
    const rec = state.players[canonicalUid(uid)];
    const name = rec ? mostCommonName(rec) : (myGames[0] && findPlayerInGame(myGames[0], uid).data.niceName) || '?';
    perMember.push({
      uid, name, n: mN, wins: mWins, losses: mLosses,
      winrate: mN ? Math.round((mWins / mN) * 100) : 0,
      kd: mDeaths ? (mKills / mDeaths).toFixed(2) : mKills.toFixed(2),
      avgDmg: mN ? Math.round(mDmg / mN) : 0,
      avgScore: mN ? Math.round(mScore / mN) : 0,
    });
  });
  return {
    n, wins, losses, distinctGames: distinctGameIds.size,
    winrate: n ? Math.round((wins / n) * 100) : 0,
    kd: deaths ? (kills / deaths).toFixed(2) : kills.toFixed(2),
    avgDmg: n ? Math.round(dmgSum / n) : 0,
    avgScore: n ? Math.round(scoreSum / n) : 0,
    kills, deaths, assists,
    perMember: perMember.sort((a, b) => b.n - a.n),
  };
}

// Construit le panneau de gestion des équipes (liste des équipes existantes + formulaire de création).
// Seuls les comptes admin peuvent créer/supprimer une équipe côté serveur (voir
// requireAdmin dans server.js — readonly ET contributor en sont exclus) — masqué
// ici aussi pour éviter des actions vouées à échouer.
function renderTeamManager() {
  const canWrite = !state.currentUser || state.currentUser.role === 'admin';
  const teamList = Object.values(state.customTeams);
  const chips = teamList.map(t => `
    <div class="team-chip">
      <span class="team-chip-name">${t.name}</span>
      <span class="team-chip-count">${t.members.length} joueur(s)</span>
      ${canWrite ? `<button data-delete-team="${t.id}" title="Supprimer l'équipe">✕</button>` : ''}
    </div>`).join('') || `<div style="color:var(--muted);font-size:13px;">Aucune équipe créée pour l'instant.</div>`;

  if (!canWrite) {
    return `
      <div class="team-manager">
        <div class="section-title">Équipes</div>
        <div class="team-chip-row">${chips}</div>
      </div>`;
  }

  const knownPlayers = allKnownPlayers().sort((a, b) => b.games - a.games);
  const checklist = knownPlayers.map(p => `
    <label>
      <input type="checkbox" data-member="${p.uid}">
      <span>${p.name} <span style="color:var(--muted);">(${p.games})</span></span>
    </label>`).join('') || `<div style="color:var(--muted);font-size:12px;">Importe d'abord des parties pour pouvoir choisir des joueurs.</div>`;

  return `
    <div class="team-manager">
      <div class="section-title">Tes équipes</div>
      <div class="team-chip-row">${chips}</div>
      <div class="team-create-form">
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Créer une nouvelle équipe :</div>
        <input type="text" id="newTeamName" placeholder="Nom de l'équipe (ex: Mon squad)">
        <button class="btn primary small" id="createTeamBtn">+ Créer</button>
        <div class="member-checklist" id="newTeamMembers">${checklist}</div>
      </div>
    </div>`;
}

// Recharge la liste des équipes depuis le serveur (après création/suppression).
async function refreshTeamsFromServer() {
  const teams = await apiGet('/api/teams');
  state.customTeams = {};
  teams.forEach(t => { state.customTeams[t.id] = t; });
}

// Branche les évènements du panneau de gestion des équipes (créer, supprimer).
function wireTeamManager() {
  document.querySelectorAll('[data-delete-team]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteTeam;
      if (!confirm(`Supprimer l'équipe "${state.customTeams[id]?.name || ''}" ?`)) return;
      try {
        await apiSend('DELETE', `/api/teams/${id}`);
        await refreshTeamsFromServer();
        if (state.teamAId === id) state.teamAId = null;
        if (state.teamBId === id) state.teamBId = null;
        persistUiPrefs();
        renderEquipes();
      } catch (e) {
        alert("Erreur lors de la suppression de l'équipe : " + e.message);
      }
    });
  });
  const createBtn = document.getElementById('createTeamBtn');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const nameInput = document.getElementById('newTeamName');
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const members = Array.from(document.querySelectorAll('#newTeamMembers input[data-member]:checked'))
        .map(cb => cb.dataset.member);
      if (!members.length) { alert('Sélectionne au moins un joueur pour cette équipe.'); return; }
      try {
        const team = await apiSend('POST', '/api/teams', { name, members });
        state.customTeams[team.id] = team;
        if (!state.teamAId) state.teamAId = team.id;
        else if (!state.teamBId) state.teamBId = team.id;
        persistUiPrefs();
        renderEquipes();
      } catch (e) {
        alert("Erreur lors de la création de l'équipe : " + e.message);
      }
    });
  }
}

// Construit la carte de stats agrégées d'une équipe.
function renderTeamStatCard(label, agg) {
  return `
    <div class="profile-grid" style="margin-bottom:6px;">
      <div class="cell"><div class="label">Parties distinctes</div><div class="value">${agg.distinctGames}</div></div>
      <div class="cell"><div class="label">Participations cumulées</div><div class="value">${agg.n}</div></div>
      <div class="cell"><div class="label">V / D</div><div class="value" style="font-size:16px;"><span class="win">${agg.wins}</span> / <span class="loss">${agg.losses}</span></div></div>
      <div class="cell"><div class="label">Taux de victoire</div><div class="value">${agg.winrate}%</div></div>
      <div class="cell"><div class="label">Ratio K/D</div><div class="value">${agg.kd}</div></div>
      <div class="cell"><div class="label">Kills / Morts / Assists</div><div class="value" style="font-size:16px;">${agg.kills} / ${agg.deaths} / ${agg.assists}</div></div>
      <div class="cell"><div class="label">Dégâts moyens</div><div class="value">${agg.avgDmg}</div></div>
      <div class="cell"><div class="label">Score moyen</div><div class="value">${agg.avgScore}</div></div>
    </div>`;
}

// Construit le tableau détaillé par joueur d'une équipe.
function renderTeamMemberTable(agg) {
  const rows = agg.perMember.map(m => `
    <tr>
      <td class="name-cell">${m.name}</td>
      <td class="num">${m.n}</td>
      <td class="num"><span class="win">${m.wins}</span> / <span class="loss">${m.losses}</span></td>
      <td class="num">${m.winrate}%</td>
      <td class="num ${m.kd>=1?'kd-good':'kd-bad'}">${m.kd}</td>
      <td class="num">${m.avgDmg}</td>
      <td class="num">${m.avgScore}</td>
    </tr>`).join('');
  return `
    <div class="table-scroll"><table class="roster">
      <thead><tr><th>Joueur</th><th class="num">Parties</th><th class="num">V / D</th><th class="num">Winrate</th><th class="num">K/D</th><th class="num">Dégâts moy.</th><th class="num">Score moy.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// Construit une ligne de comparaison à deux valeurs avec barre colorée proportionnelle (utilisé par Équipes et par le panneau de comparaison du Profil).
export function compareRow(label, valA, valB, fmt, higherIsBetter) {
  fmt = fmt || (v => v);
  higherIsBetter = higherIsBetter !== false;
  const numA = parseFloat(valA), numB = parseFloat(valB);
  const maxAbs = Math.max(Math.abs(numA), Math.abs(numB)) || 1;
  const pctA = Math.min(100, Math.round((Math.abs(numA) / maxAbs) * 100));
  const pctB = Math.min(100, Math.round((Math.abs(numB) / maxAbs) * 100));
  const aWins = higherIsBetter ? numA > numB : numA < numB;
  const bWins = higherIsBetter ? numB > numA : numB < numA;
  return `
    <div class="metric-label">${label}</div>
    <div class="metric-val" style="color:${aWins?'var(--win)':'var(--text)'}">${fmt(valA)}</div>
    <div></div>
    <div class="metric-val" style="color:${bWins?'var(--win)':'var(--text)'}">${fmt(valB)}</div>
    <div class="metric-bar-wrap left"><div class="fill" style="width:${pctA}%;background:var(--alliance);"></div></div>
    <div></div>
    <div class="metric-bar-wrap"><div class="fill" style="width:${pctB}%;background:var(--rebels);"></div></div>
  `;
}

// Point d'entrée de l'onglet Équipes.
export function renderEquipes() {
  const container = document.getElementById('equipesContent');
  const games = filteredGamesArray();
  const teamList = Object.values(state.customTeams);

  let html = renderTeamManager();

  if (teamList.length) {
    html += `
      <div class="team-select-row">
        <div class="player-select">
          <label for="teamAPicker">Équipe A</label>
          <select id="teamAPicker">
            <option value="">— choisir —</option>
            ${teamList.map(t => `<option value="${t.id}" ${state.teamAId===t.id?'selected':''}>${t.name}</option>`).join('')}
          </select>
        </div>
        <div class="player-select">
          <label for="teamBPicker">Équipe B (optionnel, pour comparer)</label>
          <select id="teamBPicker">
            <option value="">— aucune —</option>
            ${teamList.map(t => `<option value="${t.id}" ${state.teamBId===t.id?'selected':''}>${t.name}</option>`).join('')}
          </select>
        </div>
      </div>`;

    const teamA = state.teamAId ? state.customTeams[state.teamAId] : null;
    const teamB = state.teamBId ? state.customTeams[state.teamBId] : null;

    if (teamA && teamB && teamA.id !== teamB.id) {
      const aggA = computeTeamAggregate(teamA.members, games);
      const aggB = computeTeamAggregate(teamB.members, games);
      html += `
        <div class="team-vs-header">
          <span class="team-name" style="color:var(--alliance);">${teamA.name}</span>
          <span class="vs">VS</span>
          <span class="team-name" style="color:var(--rebels);">${teamB.name}</span>
        </div>
        <div class="compare-grid">
          ${compareRow('Taux de victoire', aggA.winrate+'%', aggB.winrate+'%', v=>v)}
          ${compareRow('Ratio K/D', aggA.kd, aggB.kd, v=>v)}
          ${compareRow('Dégâts moyens', aggA.avgDmg, aggB.avgDmg, v=>Number(v).toLocaleString('fr-FR'))}
          ${compareRow('Score moyen', aggA.avgScore, aggB.avgScore, v=>Number(v).toLocaleString('fr-FR'))}
          ${compareRow('Parties distinctes', aggA.distinctGames, aggB.distinctGames, v=>v)}
        </div>
        <div class="analytics-grid-2" style="margin-top:26px;">
          <div>
            <div class="section-title" style="color:var(--alliance);">${teamA.name} — détail par joueur</div>
            ${renderTeamMemberTable(aggA)}
          </div>
          <div>
            <div class="section-title" style="color:var(--rebels);">${teamB.name} — détail par joueur</div>
            ${renderTeamMemberTable(aggB)}
          </div>
        </div>`;
    } else if (teamA) {
      const agg = computeTeamAggregate(teamA.members, games);
      html += `
        <div class="section-title">${teamA.name}</div>
        ${renderTeamStatCard('', agg)}
        <div class="section-title" style="margin-top:22px;">Détail par joueur</div>
        ${renderTeamMemberTable(agg)}`;
    } else {
      html += `<div class="detail-empty">Choisis une équipe A ci-dessus pour voir ses stats (et une équipe B pour comparer).</div>`;
    }
  }

  container.innerHTML = html;
  wireTeamManager();

  const pickerA = document.getElementById('teamAPicker');
  const pickerB = document.getElementById('teamBPicker');
  if (pickerA) pickerA.addEventListener('change', () => { state.teamAId = pickerA.value || null; persistUiPrefs(); renderEquipes(); });
  if (pickerB) pickerB.addEventListener('change', () => { state.teamBId = pickerB.value || null; persistUiPrefs(); renderEquipes(); });
}
