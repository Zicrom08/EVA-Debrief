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
import { renderGameAnalytics, attachProfileMetricButtons, renderRankSection } from './analytics-view.js';
import { computeLpHistory, gamesForLpScope } from '../rank.js';

// Groupes thématiques de l'onglet Profil (voir renderGameAnalytics() dans analytics-view.js
// pour pg-performance/progression/classements/cartes/duels — pg-overview est construit ici).
// Source unique pour la nav sticky (renderProfileNav()) ET les ancres réellement posées dans
// le HTML : ajouter un groupe ici et son <section id="..."> correspondant suffit à l'ajouter
// à la navigation, pas besoin de toucher wireProfileNav()/le scrollspy.
const PROFILE_NAV_GROUPS = [
  { id: 'pg-overview', label: 'Vue d\'ensemble' },
  { id: 'pg-performance', label: 'Performance' },
  { id: 'pg-progression', label: 'Progression' },
  { id: 'pg-classements', label: 'Classements' },
  { id: 'pg-cartes', label: 'Cartes & habitudes' },
  { id: 'pg-duels', label: 'Duels & synergies' },
];

// ================= PROFIL : point d'entrée =================
export function renderProfil() {
  const container = document.getElementById('profilContent');
  const uid = state.currentUid;
  const games = uid ? gamesForPlayerSorted(uid) : [];
  container.innerHTML = `
    ${renderProfileNav(uid, games)}
    <div class="profile-layout">
      <div class="profile-main">${renderProfilMain(uid, games)}</div>
      <div class="profile-compare">${renderProfilComparePicker(uid)}${renderProfilCompareDetails(uid)}</div>
    </div>
  `;
  attachProfileMetricButtons();
  wireProfilComparePicker();
  wireProfileNav();
}

// Fil d'ancres sticky en haut de l'onglet Profil : un lien par groupe thématique
// (PROFILE_NAV_GROUPS ci-dessus), pensé pour une page aussi longue que celle-ci — sauter
// directement à "Duels & synergies" sans dérouler tout le reste. N'affiche que les groupes
// qui vont réellement exister dans le HTML rendu (mêmes conditions que renderProfilMain()/
// renderGameAnalytics() : pas de lien mort vers une section qui ne sera pas là). Masqué
// entièrement en dessous de 2 groupes visibles — inutile de naviguer une page d'un seul écran.
function renderProfileNav(uid, games) {
  if (!uid) return '';
  const hasAnalytics = games.length >= 3;
  const visible = PROFILE_NAV_GROUPS.filter(g => g.id === 'pg-overview' || hasAnalytics);
  if (visible.length < 2) return '';
  return `
    <nav class="profile-nav" id="profileNav">
      ${visible.map(g => `<a href="#${g.id}" class="profile-nav-link" data-target="${g.id}">${g.label}</a>`).join('')}
    </nav>`;
}

// Câble le clic (défilement fluide, en tenant compte de la hauteur de la nav elle-même
// sticky au-dessus) et le scrollspy (surbrillance du groupe visible) — recréé à chaque
// rendu du Profil puisque le HTML est entièrement reconstruit à chaque fois (voir
// renderProfil()) ; l'ancien IntersectionObserver, lui, est explicitement coupé d'abord
// pour ne pas laisser un observer orphelin tourner sur des nœuds DOM déjà détachés.
let profileNavObserver = null;
function wireProfileNav() {
  if (profileNavObserver) { profileNavObserver.disconnect(); profileNavObserver = null; }
  const nav = document.getElementById('profileNav');
  if (!nav) return;
  const links = [...nav.querySelectorAll('.profile-nav-link')];

  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(link.dataset.target);
      if (!target) return;
      const navHeight = nav.getBoundingClientRect().height;
      const y = target.getBoundingClientRect().top + window.scrollY - navHeight - 16;
      window.scrollTo({ top: y, behavior: 'smooth' });
    });
  });

  if (typeof IntersectionObserver === 'undefined') return; // environnement sans DOM (tests) — pas de scrollspy, le clic seul reste fonctionnel
  const navHeight = nav.getBoundingClientRect().height;
  profileNavObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const link = nav.querySelector(`.profile-nav-link[data-target="${entry.target.id}"]`);
      if (!link) return;
      links.forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  }, { rootMargin: `-${navHeight + 20}px 0px -70% 0px` });
  links.forEach(link => {
    const target = document.getElementById(link.dataset.target);
    if (target) profileNavObserver.observe(target);
  });
}

// Construit la colonne principale de l'onglet Profil (carte de saison + toutes les sections d'analyse).
export function renderProfilMain(uid, games) {
  games = games || (uid ? gamesForPlayerSorted(uid) : []);
  const snaps = uid ? filteredSnapshotsForUser(uid) : null;
  const baseline = (uid && snaps && snaps.length) ? seasonCardBaseline(uid, snaps) : null;

  let html = '';

  if (!uid) {
    html += `<div class="detail-empty" style="margin-top:0;">
      Sélectionne un joueur dans la barre en haut de la page pour voir son profil.
    </div>`;
    return html;
  }

  let overview = '';
  if (snaps && snaps.length) {
    overview += renderSeasonCard(snaps, baseline, games);
    if (snaps.length > 1) {
      overview += renderEvolutionTable(snaps, games);
    } else {
      overview += `<div class="evolution-hint">
        Une seule capture pour l'instant. Importe à nouveau le profil de ce joueur plus tard
        (après une session de jeu, par exemple) pour voir son évolution ici : progression
        de kills, dégâts, winrate entre deux dates.
      </div>`;
    }
  } else if (uid && (state.playerStatsSnapshots[uid] || []).length) {
    overview += `<div class="detail-empty" style="margin-top:0;">
      Aucune capture de profil pour ce joueur dans la saison/période sélectionnée.<br>
      Change le filtre de saison en haut de page pour voir ses autres captures.
    </div>`;
  } else {
    overview += `<div class="detail-empty" style="margin-top:0;text-align:left;">
      <strong>Aucune statistique de saison importée pour ce joueur.</strong><br><br>
      Le plus simple : installe l'extension navigateur EVA-Debrief, lie-la à ce compte
      en un clic (bouton "Lier l'extension EVA-Debrief" dans "+ Importer", ou depuis le
      popup de l'extension elle-même), puis navigue normalement sur la page de profil
      <strong>connectée</strong> de ce joueur sur EVA — la capture et l'envoi se font
      ensuite automatiquement, sans rien télécharger ni réimporter à la main.
      Voir <code>browser-extension/README.md</code> dans le dépôt pour l'installation
      (Chrome, Edge, Kiwi Browser).<br><br>
      <span style="color:var(--muted);font-size:12px;">
        🔜 À venir : une version packagée de l'extension, installable en un clic
        directement depuis ce site, sans passer par le mode développeur du navigateur.
      </span><br><br>
      Les profils publics n'existent plus sur EVA — seule sa propre page de profil connectée
      (<code>getPlayerByUserId</code>) peut être capturée.
    </div>`;
  }
  overview += renderRankSection(uid);

  html += `<section class="profile-group" id="pg-overview">
    <h2 class="profile-group-title">Vue d'ensemble</h2>
    ${overview}
  </section>`;

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
  // LP indépendant de gamesA/gamesB (période filtrée) — voir gamesForLpScope() dans
  // rank.js, même principe que renderRankSection() : le rang ne suit que la sélection de
  // saison, jamais une période libre.
  const { lpByUid } = computeLpHistory(gamesForLpScope());
  const lpA = lpByUid.get(uid);
  const lpB = lpByUid.get(state.profileCompareUid);

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
        ${lpA != null && lpB != null ? compareRow('Rang (LP)', Math.round(lpA), Math.round(lpB), num, true, intDiff) : ''}
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
