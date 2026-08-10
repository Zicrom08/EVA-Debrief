import { state } from '../state.js';
import { latestNiceName, fmtDelta } from '../format.js';
import { gamesForPlayerSorted, filteredGamesArray } from '../game-filters.js';
import { filteredSnapshotsForUser, seasonCardBaseline } from '../seasons.js';
import { aggregateGames } from '../tendances.js';
import { compareRow } from '../equipes.js';
import { persistUiPrefs } from '../ui-prefs.js';
import {
  computeEfficiencyStats, computeRankStats, computeStreaks,
  computeImpactScore, computeDamageTeamStats, computeRatingBaseline, computeRating,
} from './compute.js';
import { renderSeasonCard, renderEvolutionTable } from './season.js';
import { renderGameAnalytics, attachProfileMetricButtons } from './analytics-view.js';

// ================= PROFIL : point d'entrée =================
export function renderProfil() {
  const container = document.getElementById('profilContent');
  const uid = state.currentUid;
  container.innerHTML = `
    <div class="profile-layout">
      <div class="profile-main">${renderProfilMain(uid)}</div>
      <div class="profile-compare">${renderProfilComparePicker(uid)}${renderProfilCompareDetails(uid)}</div>
    </div>
  `;
  attachProfileMetricButtons();
  wireProfilComparePicker();
}

// Construit la colonne principale de l'onglet Profil (carte de saison + toutes les sections d'analyse).
export function renderProfilMain(uid) {
  const snaps = uid ? filteredSnapshotsForUser(uid) : null;
  const baseline = (uid && snaps && snaps.length) ? seasonCardBaseline(uid, snaps) : null;
  const games = uid ? gamesForPlayerSorted(uid) : [];

  let html = '';

  if (snaps && snaps.length) {
    html += renderSeasonCard(snaps, baseline, games);
    if (snaps.length > 1) {
      html += renderEvolutionTable(snaps);
    } else {
      html += `<div class="evolution-hint">
        Une seule capture pour l'instant. Importe à nouveau le profil de ce joueur plus tard
        (après une session de jeu, par exemple) pour voir son évolution ici : progression
        de kills, dégâts, winrate entre deux dates.
      </div>`;
    }
  } else if (uid && (state.playerStatsSnapshots[uid] || []).length) {
    html += `<div class="detail-empty" style="margin-top:0;">
      Aucune capture de profil pour ce joueur dans la saison/période sélectionnée.<br>
      Change le filtre de saison en haut de page pour voir ses autres captures.
    </div>`;
  } else {
    html += `<div class="detail-empty" style="margin-top:0;">
      Aucune statistique de saison importée pour ce joueur.<br>
      Les profils publics n'existent plus sur EVA — seule sa propre page de profil connectée
      (<code>getPlayerByUserId</code>) peut être capturée, via "+ Importer".
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

// ================= PROFIL : sélecteur du second joueur (reste dans la colonne étroite) =================
// Le comparatif détaillé lui-même (renderProfilCompareDetails ci-dessous) s'affiche en
// pleine largeur sous les deux colonnes, pas ici : trop de statistiques pour tenir dans
// une barre latérale de 380px (voir renderProfil()).
export function renderProfilComparePicker(uid) {
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
          `<option value="${pid}" ${state.profileCompareUid == pid ? 'selected' : ''}>${latestNiceName(rec)}</option>`
        ).join('')}
      </select>
    </div>`;

  if (!otherCandidates.length) {
    html += `<div class="evolution-hint" style="margin-top:16px;">Importe l'historique d'au moins un autre joueur pour pouvoir comparer.</div>`;
  } else if (!state.profileCompareUid || !state.players[state.profileCompareUid]) {
    html += `<div class="evolution-hint" style="margin-top:16px;">Choisis un joueur ci-dessus pour voir un comparatif détaillé, calculé sur la même période et les mêmes filtres que le profil principal.</div>`;
  }
  return html;
}

// ================= PROFIL : comparatif détaillé (colonne de droite, sous le sélecteur) =================
// Toutes les statistiques scalaires déjà calculées ailleurs pour un profil (agrégats de
// base, efficacité, rating façon HLTV, score d'impact, contribution d'équipe, séries) —
// pas les graphiques/distributions (cartes, modes, jour/heure, duo-némésis...), qui n'ont
// pas de sens à "diffé" ligne à ligne. Joueur principal (uid) toujours à gauche, comparé
// à droite (voir compareRow() dans equipes.js) ; écart (droite - gauche) affiché au
// centre de chaque ligne. Reste dans la colonne étroite `.profile-compare` (voir
// renderProfil()) — police réduite (compare-grid-narrow) pour que les 18 lignes restent
// lisibles à cette largeur.
export function renderProfilCompareDetails(uid) {
  if (!uid || !state.players[uid]) return '';
  if (!state.profileCompareUid || !state.players[state.profileCompareUid]) return '';

  const nameA = latestNiceName(state.players[uid]);
  const nameB = latestNiceName(state.players[state.profileCompareUid]);
  const gamesA = gamesForPlayerSorted(uid);
  const gamesB = gamesForPlayerSorted(state.profileCompareUid);

  if (!gamesA.length || !gamesB.length) {
    return `<div class="evolution-hint" style="margin-top:16px;">
      ${!gamesA.length ? nameA : nameB} n'a aucune partie importée sur la période/filtres actuels — le comparatif a besoin de parties des deux côtés.
    </div>`;
  }

  const aggA = aggregateGames(gamesA, uid);
  const aggB = aggregateGames(gamesB, state.profileCompareUid);
  const effA = computeEfficiencyStats(gamesA, uid);
  const effB = computeEfficiencyStats(gamesB, state.profileCompareUid);
  const rankA = computeRankStats(gamesA, uid);
  const rankB = computeRankStats(gamesB, state.profileCompareUid);
  const streaksA = computeStreaks(gamesA, uid);
  const streaksB = computeStreaks(gamesB, state.profileCompareUid);
  const impactA = computeImpactScore(gamesA, uid);
  const impactB = computeImpactScore(gamesB, state.profileCompareUid);
  const dmgTeamA = computeDamageTeamStats(gamesA, uid);
  const dmgTeamB = computeDamageTeamStats(gamesB, state.profileCompareUid);
  // Même population de référence pour les deux joueurs (toutes les parties filtrées de la
  // période, pas seulement les leurs) — voir computeRatingBaseline, même principe que le
  // classement du Comparatif.
  const ratingBaseline = computeRatingBaseline(filteredGamesArray());
  const ratingA = computeRating(gamesA, uid, ratingBaseline);
  const ratingB = computeRating(gamesB, state.profileCompareUid, ratingBaseline);

  const pct = v => v; // valeurs déjà formatées en chaîne "12%" au point d'appel
  const num = v => Number(v).toLocaleString('fr-FR');
  const pctDiff = d => fmtDelta(d, 0) + '%';
  const intDiff = d => fmtDelta(d, 0);
  const decDiff = d => fmtDelta(d, 2);

  return `
    <div class="compare-panel-card" style="margin-top:16px;">
      <div class="team-vs-header">
        <span class="team-name" style="color:var(--alliance);font-size:15px;">${nameA}</span>
        <span class="vs" style="font-size:12px;">VS</span>
        <span class="team-name" style="color:var(--rebels);font-size:15px;">${nameB}</span>
      </div>
      <div class="compare-grid compare-grid-narrow">
        <div class="metric-label" style="grid-column:1/-1;margin-top:0;">Général</div>
        ${compareRow('Parties (période)', aggA.n, aggB.n, num, true, intDiff)}
        ${compareRow('Victoires', aggA.wins, aggB.wins, num, true, intDiff)}
        ${compareRow('Défaites', aggA.losses, aggB.losses, num, false, intDiff)}
        ${compareRow('Taux de victoire', aggA.winrate + '%', aggB.winrate + '%', pct, true, pctDiff)}

        <div class="metric-label">Performance</div>
        ${compareRow('Ratio K/D', aggA.kd, aggB.kd, pct, true, decDiff)}
        ${compareRow('KDA', effA.kda, effB.kda, pct, true, decDiff)}
        ${compareRow('Kills / partie', (aggA.kills / aggA.n).toFixed(1), (aggB.kills / aggB.n).toFixed(1), pct, true, decDiff)}
        ${compareRow('Morts / partie', (aggA.deaths / aggA.n).toFixed(1), (aggB.deaths / aggB.n).toFixed(1), pct, false, decDiff)}
        ${compareRow('Assists / partie', effA.avgAssists, effB.avgAssists, pct, true, decDiff)}
        ${compareRow('Dégâts moyens', aggA.avgDmg, aggB.avgDmg, num, true, intDiff)}
        ${compareRow('Dégâts par mort', effA.dmgPerDeath, effB.dmgPerDeath, num, true, intDiff)}
        ${compareRow('Score moyen', aggA.avgScore, aggB.avgScore, num, true, intDiff)}
        ${compareRow('Précision moyenne', effA.avgAccuracy + '%', effB.avgAccuracy + '%', pct, true, pctDiff)}

        <div class="metric-label">Indices composites</div>
        ${ratingA.rating != null && ratingB.rating != null ? compareRow('Rating (façon HLTV)', ratingA.rating, ratingB.rating, pct, true, decDiff) : ''}
        ${compareRow("Score d'impact", impactA.score, impactB.score, num, true, intDiff)}
        ${compareRow('Contribution dégâts équipe', dmgTeamA.avgContribPct + '%', dmgTeamB.avgContribPct + '%', pct, true, pctDiff)}
        ${compareRow('Taux de MVP', rankA.mvpRate + '%', rankB.mvpRate + '%', pct, true, pctDiff)}

        <div class="metric-label">Séries</div>
        ${compareRow('Meilleure série de victoires', streaksA.bestWin, streaksB.bestWin, num, true, intDiff)}
        ${compareRow('Pire série de défaites', streaksA.worstLoss, streaksB.worstLoss, num, false, intDiff)}
      </div>
    </div>`;
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
