import { state } from '../state.js';
import { mostCommonName } from '../format.js';
import { gamesForPlayerSorted } from '../game-filters.js';
import { aggregateGames } from '../tendances.js';
import { compareRow } from '../equipes.js';
import { persistUiPrefs } from '../ui-prefs.js';
import { computeEfficiencyStats, computeRankStats, computeStreaks } from './compute.js';
import { renderSeasonCard, renderEvolutionTable } from './season.js';
import { renderGameAnalytics, attachProfileMetricButtons } from './analytics-view.js';

// ================= PROFIL : point d'entrée =================
export function renderProfil() {
  const container = document.getElementById('profilContent');
  const uid = state.currentUid;
  container.innerHTML = `
    <div class="profile-layout">
      <div class="profile-main">${renderProfilMain(uid)}</div>
      <div class="profile-compare">${renderProfilComparePanel(uid)}</div>
    </div>
  `;
  attachProfileMetricButtons();
  wireProfilComparePicker();
}

// Construit la colonne principale de l'onglet Profil (carte de saison + toutes les sections d'analyse).
export function renderProfilMain(uid) {
  const snaps = uid ? state.playerStatsSnapshots[uid] : null;
  const games = uid ? gamesForPlayerSorted(uid) : [];

  let html = '';

  if (snaps && snaps.length) {
    html += renderSeasonCard(snaps);
    if (snaps.length > 1) {
      html += renderEvolutionTable(snaps);
    } else {
      html += `<div class="evolution-hint">
        Une seule capture pour l'instant. Importe à nouveau le profil de ce joueur plus tard
        (après une session de jeu, par exemple) pour voir son évolution ici : progression
        de kills, dégâts, winrate entre deux dates.
      </div>`;
    }
  } else {
    html += `<div class="detail-empty" style="margin-top:0;">
      Aucune statistique de saison importée pour ce joueur.<br>
      Importe son profil (<code>getPlayerByUserId</code> ou <code>getPublicPlayerByUsername</code>) via "+ Importer".
    </div>`;
  }

  if (games.length >= 3) {
    html += renderGameAnalytics(games, uid);
  } else if (games.length > 0) {
    html += `<div class="evolution-hint">Importe au moins 3 parties pour ce joueur pour débloquer les graphiques de progression, séries et performances par carte.</div>`;
  } else if (snaps && snaps.length) {
    html += `<div class="evolution-hint">Importe aussi l'historique de parties de ce joueur pour débloquer les graphiques de progression, séries, performance par carte/mode et meilleures parties.</div>`;
  }

  return html;
}

// ================= PROFIL : panneau de comparaison avec un second joueur =================
export function renderProfilComparePanel(uid) {
  if (!uid || !state.players[uid]) return '';

  const otherCandidates = Object.entries(state.players)
    .filter(([pid]) => pid != uid)
    .sort((a, b) => b[1].games - a[1].games);

  let html = `
    <div class="compare-panel-card">
      <div class="section-title">Comparer avec</div>
      <select id="profileCompareSelect" class="compare-select">
        <option value="">— choisir un joueur —</option>
        ${otherCandidates.map(([pid, rec]) =>
          `<option value="${pid}" ${state.profileCompareUid == pid ? 'selected' : ''}>${mostCommonName(rec)}</option>`
        ).join('')}
      </select>
    </div>`;

  if (!otherCandidates.length) {
    html += `<div class="evolution-hint" style="margin-top:16px;">Importe l'historique d'au moins un autre joueur pour pouvoir comparer.</div>`;
    return html;
  }

  if (!state.profileCompareUid || !state.players[state.profileCompareUid]) {
    html += `<div class="evolution-hint" style="margin-top:16px;">Choisis un joueur ci-dessus pour voir un comparatif détaillé, calculé sur la même période et les mêmes filtres que le profil de gauche.</div>`;
    return html;
  }

  const nameA = mostCommonName(state.players[uid]);
  const nameB = mostCommonName(state.players[state.profileCompareUid]);
  const gamesA = gamesForPlayerSorted(uid);
  const gamesB = gamesForPlayerSorted(state.profileCompareUid);

  if (!gamesA.length || !gamesB.length) {
    html += `<div class="evolution-hint" style="margin-top:16px;">
      ${!gamesA.length ? nameA : nameB} n'a aucune partie importée sur la période/filtres actuels — le comparatif a besoin de parties des deux côtés.
    </div>`;
    return html;
  }

  const aggA = aggregateGames(gamesA, uid);
  const aggB = aggregateGames(gamesB, state.profileCompareUid);
  const effA = computeEfficiencyStats(gamesA, uid);
  const effB = computeEfficiencyStats(gamesB, state.profileCompareUid);
  const rankA = computeRankStats(gamesA, uid);
  const rankB = computeRankStats(gamesB, state.profileCompareUid);
  const streaksA = computeStreaks(gamesA, uid);
  const streaksB = computeStreaks(gamesB, state.profileCompareUid);

  html += `
    <div class="team-vs-header" style="margin-top:20px;">
      <span class="team-name" style="color:var(--alliance);font-size:15px;">${nameA}</span>
      <span class="vs" style="font-size:12px;">VS</span>
      <span class="team-name" style="color:var(--rebels);font-size:15px;">${nameB}</span>
    </div>
    <div class="compare-grid compare-grid-narrow">
      ${compareRow('Parties (période)', aggA.n, aggB.n, v => v)}
      ${compareRow('Taux de victoire', aggA.winrate + '%', aggB.winrate + '%', v => v)}
      ${compareRow('Ratio K/D', aggA.kd, aggB.kd, v => v)}
      ${compareRow('KDA', effA.kda, effB.kda, v => v)}
      ${compareRow('Dégâts moyens', aggA.avgDmg, aggB.avgDmg, v => Number(v).toLocaleString('fr-FR'))}
      ${compareRow('Dégâts par mort', effA.dmgPerDeath, effB.dmgPerDeath, v => Number(v).toLocaleString('fr-FR'))}
      ${compareRow('Score moyen', aggA.avgScore, aggB.avgScore, v => Number(v).toLocaleString('fr-FR'))}
      ${compareRow('Précision moyenne', effA.avgAccuracy + '%', effB.avgAccuracy + '%', v => v)}
      ${compareRow('Assists / partie', effA.avgAssists, effB.avgAssists, v => v)}
      ${compareRow('Taux de MVP', rankA.mvpRate + '%', rankB.mvpRate + '%', v => v)}
      ${compareRow('Meilleure série V', streaksA.bestWin, streaksB.bestWin, v => v)}
      ${compareRow('Pire série D', streaksA.worstLoss, streaksB.worstLoss, v => v, false)}
    </div>`;

  return html;
}

// Branche l'évènement du sélecteur de comparaison du Profil.
export function wireProfilComparePicker() {
  const sel = document.getElementById('profileCompareSelect');
  if (!sel) return;
  sel.addEventListener('change', () => {
    state.profileCompareUid = sel.value || null;
    persistUiPrefs();
    renderProfil();
  });
}
