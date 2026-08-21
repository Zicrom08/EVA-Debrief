import { state } from '../state.js';
import { findPlayerInGame } from '../format.js';
import { aggregateGames } from '../tendances.js';
import { filteredGamesArray } from '../game-filters.js';
import { renderProfil } from './index.js';
import {
  metricValue, rollingAverage, computeRollingWinRate, computeMapStats, computeModeStats,
  computeDayOfWeekStats, computeTimeOfDayStats, computeSessionFatigue, computeKDDistribution,
  computeStreaks, bestWorstGames, computeDuoNemesisStats, computeRankStats,
  computeContributionTrend, computeDamageContributionTrend, computeDamageTeamStats,
  computeEfficiencyStats, computeImpactScore,
  computeRatingBaseline, computeRating,
} from './compute.js';
import { buildLineChart, buildTrendChart, barRow, mapBarRow, distRow, highlightCard } from './charts.js';
import { computeMmrHistory, gamesForMmrScope, mmrToTier } from '../rank.js';

const METRIC_LABELS = { kd: 'Ratio K/D', dmg: 'Dégâts infligés', score: 'Score', acc: 'Précision de tir (%)' };
const NA = '<span style="color:var(--muted);">n/d</span>';

// ---- Rang compétitif : badge de palier + MMR + courbe d'évolution ----
// Fonction SÉPARÉE de renderGameAnalytics() à dessein : celle-ci reçoit des `games` déjà
// filtrés par période pour CE joueur (gamesForPlayerSorted(uid)), alors que le rang doit
// ignorer cette portée et appeler gamesForMmrScope() lui-même (voir rank.js — le MMR ne suit
// que la sélection de saison, jamais une période libre/custom). Garder ça à part rend cette
// divergence de portée visible au point d'appel plutôt que noyée dans une fonction dont le
// paramètre `games` a l'air pourtant faisant autorité.
export function renderRankSection(uid) {
  if (!uid) return '';
  const { mmrByUid, historyByUid } = computeMmrHistory(gamesForMmrScope());
  const mmr = mmrByUid.get(uid);
  const scopeNote = state.selectedSeasonId != null
    ? 'Le MMR repart d\'une base neutre à chaque saison sélectionnée — non cumulatif d\'une saison à l\'autre.'
    : 'Aucune saison sélectionnée : ce MMR est calculé sur toute la carrière du joueur.';

  if (mmr == null) {
    return `
      <div class="analytics-section">
        <div class="section-title">Rang compétitif</div>
        <div class="hl-empty">Pas assez de parties à détail complet dans cette portée pour calculer un rang (voir CLAUDE.md/hasFullMatchData).</div>
      </div>`;
  }

  const tier = mmrToTier(mmr);
  const history = historyByUid.get(uid) || [];
  const chart = history.length >= 2 ? buildLineChart(history.map(h => h.mmrAfter), {
    color: 'var(--gold)', decimals: 0, fill: true,
    legendLabel: 'MMR au fil des parties',
  }) : '<div class="hl-empty">Pas assez de parties dans cette portée pour une courbe (2 minimum).</div>';

  return `
    <div class="analytics-section">
      <div class="section-title">Rang compétitif</div>
      <div class="streak-row">
        <div class="streak-card">
          <div class="streak-label">Rang</div>
          <div class="streak-value"><span class="tier-badge ${tier.tierKey}">${tier.name}</span></div>
        </div>
        <div class="streak-card">
          <div class="streak-label">MMR</div>
          <div class="streak-value">${Math.round(mmr)}</div>
        </div>
        <div class="streak-card">
          <div class="streak-label">Progression dans la division</div>
          <div class="streak-value" style="font-size:20px;">${tier.progressPct}%</div>
          <div class="score-bar" style="height:7px;margin-top:8px;"><div class="a" style="width:${tier.progressPct}%"></div></div>
        </div>
      </div>
      <div class="chart-card" style="margin-top:16px;">${chart}</div>
      <div class="evolution-hint" style="margin-top:12px;">${scopeNote}</div>
    </div>`;
}

// ---- Focus carte : mini-profil dédié à une carte, ouvert en cliquant une ligne
// dans "Performance par carte" (voir mapBarRow / data-map-select) ----
export function renderMapDeepDive(games, uid, mapsStats) {
  if (!state.mapDeepDiveSelection) return '';
  const stillAvailable = mapsStats.some(m => m.name === state.mapDeepDiveSelection);
  if (!stillAvailable) return '';

  const mapGames = games.filter(g => (g.map && g.map.name) === state.mapDeepDiveSelection);
  if (!mapGames.length) return '';

  const agg = aggregateGames(mapGames, uid);
  const bw = bestWorstGames(mapGames, uid);
  const kdVals = mapGames.map(g => {
    const p = findPlayerInGame(g, uid);
    return p && p.data.deaths ? p.data.kills / p.data.deaths : ((p && p.data.kills) || 0);
  });
  const chart = kdVals.length >= 2 ? buildLineChart(kdVals, {
    color: 'var(--gold)', yMin: 0, decimals: 2, fill: true,
    legendLabel: `Ratio K/D partie par partie sur ${state.mapDeepDiveSelection}`,
  }) : '<div class="hl-empty">Pas assez de parties sur cette carte pour une courbe.</div>';

  return `
    <div class="analytics-section" id="mapDeepDive">
      <div class="section-title-row">
        <div class="section-title">Focus carte — ${state.mapDeepDiveSelection}</div>
        <button class="btn small" id="mapDeepDiveClose">✕ Fermer</button>
      </div>
      <div class="profile-grid" style="margin-bottom:16px;">
        <div class="cell"><div class="label">Parties</div><div class="value">${agg.n}</div></div>
        <div class="cell"><div class="label">Taux de victoire</div><div class="value">${agg.winrate}%</div></div>
        <div class="cell"><div class="label">Ratio K/D</div><div class="value">${agg.kd}</div></div>
        <div class="cell"><div class="label">Dégâts moyens</div><div class="value">${agg.avgDmg}</div></div>
      </div>
      <div class="chart-card">${chart}</div>
      <div class="highlight-grid" style="margin-top:16px;">
        ${highlightCard('Meilleur K/D sur cette carte', bw.bestKD, e => e.kd.toFixed(2), 'var(--gold)')}
        ${highlightCard('Plus gros dégâts sur cette carte', bw.bestDmg, e => e.val.toLocaleString('fr-FR'), 'var(--gold)')}
        ${highlightCard('Meilleur score sur cette carte', bw.bestScore, e => e.val.toLocaleString('fr-FR'), 'var(--gold)')}
        ${highlightCard('Partie la plus difficile ici', bw.worst, e => e.val.toLocaleString('fr-FR')+' pts', 'var(--loss)')}
      </div>
    </div>`;
}

// Construit l'ensemble des sections d'analyse du Profil à partir de l'historique de parties du joueur (cœur de l'onglet Profil).
export function renderGameAnalytics(games, uid) {
  const streaks = computeStreaks(games, uid);
  const mapsStats = computeMapStats(games, uid);
  const modeStats = computeModeStats(games, uid);
  const dowStats = computeDayOfWeekStats(games, uid);
  const todStats = computeTimeOfDayStats(games, uid);
  const fatigueStats = computeSessionFatigue(games, uid, 45);
  const kdDist = computeKDDistribution(games, uid);
  const bw = bestWorstGames(games, uid);
  const rankStats = computeRankStats(games, uid);
  const efficiency = computeEfficiencyStats(games, uid);
  const impact = computeImpactScore(games, uid);
  const ratingBaseline = computeRatingBaseline(filteredGamesArray());
  const rating = computeRating(games, uid, ratingBaseline);

  const rawVals = games.map(g => metricValue(findPlayerInGame(g, uid), state.profileMetric));
  const window = Math.min(5, Math.max(2, Math.round(games.length / 4) || 2));
  const avgVals = rollingAverage(rawVals, window);
  const trendChart = buildTrendChart(rawVals, avgVals, state.profileMetric === 'acc' ? '%' : '');

  const wrWindow = Math.min(10, games.length);
  const wrVals = computeRollingWinRate(games, uid, wrWindow);
  const wrChart = buildLineChart(wrVals, {
    color: 'var(--win)', yMin: 0, yMax: 100, pixelHeight: 130, unit: '%', decimals: 0,
    refValue: 50, refLabel: '50% (équilibre)', fill: true,
    legendLabel: `Winrate glissant sur les ${wrWindow} dernières parties`,
  });

  const contribVals = computeContributionTrend(games, uid);
  const contribChart = contribVals.length ? buildLineChart(contribVals, {
    color: 'var(--alliance)', yMin: 0, yMax: 100, pixelHeight: 130, unit: '%', decimals: 0,
    fill: true, legendLabel: `Part du score total de l'équipe apportée par toi, partie par partie`,
  }) : '<div class="hl-empty">Pas assez de données</div>';

  const dmgContribVals = computeDamageContributionTrend(games, uid);
  const dmgContribChart = dmgContribVals.length ? buildLineChart(dmgContribVals, {
    color: 'var(--rebels)', yMin: 0, yMax: 100, pixelHeight: 130, unit: '%', decimals: 0,
    fill: true, legendLabel: `Part des dégâts totaux de l'équipe apportée par toi, partie par partie`,
  }) : '<div class="hl-empty">Pas assez de données</div>';
  const dmgTeamStats = computeDamageTeamStats(games, uid);

  const streakLabel = streaks.currentType === 'Victory' ? `${streaks.currentCount} victoire(s) d'affilée`
    : streaks.currentType === 'Defeat' ? `${streaks.currentCount} défaite(s) d'affilée` : '—';
  const streakColor = streaks.currentType === 'Victory' ? 'var(--win)' : streaks.currentType === 'Defeat' ? 'var(--loss)' : 'var(--muted)';

  const mapRows = mapsStats.map(m => mapBarRow(m.name, m.winrate, `${m.n} partie(s) · K/D ${m.kd} · ${m.avgDmg} dmg moy.`)).join('');
  const modeRows = modeStats.map(m => barRow(m.name, m.winrate, `${m.n} partie(s) · K/D ${m.kd}`)).join('');
  const dowRows = dowStats.map(d => barRow(d.label, d.winrate, d.n ? `${d.n} partie(s)` : 'aucune partie')).join('');
  const todRows = todStats.map(d => barRow(d.label, d.winrate, d.n ? `${d.n} partie(s)` : 'aucune partie')).join('');
  const fatigueRows = fatigueStats.map(f => barRow(f.label, f.winrate, `${f.n} partie(s) · K/D ${f.kd}`)).join('');
  const kdDistMax = Math.max(...kdDist.map(b => b.n), 1);
  const kdDistRows = kdDist.map(b => distRow(b.label, b.n, kdDistMax)).join('');
  const rankDistMax = Math.max(...rankStats.dist.map(b => b.n), 1);
  const rankRows = rankStats.dist.map(b => distRow(b.label, b.n, rankDistMax)).join('');

  const duoNemesis = computeDuoNemesisStats(games, uid, 3);
  const duoRows = duoNemesis.duoArr.slice(0, 5)
    .map(d => barRow(d.name, d.winrate, `${d.n} partie(s) ensemble · ${d.wins} victoire(s)`)).join('');
  const nemesisRows = duoNemesis.nemesisArr.slice(0, 5)
    .map(d => barRow(d.name, d.winrate, `${d.n} partie(s) affrontées · ${d.n - d.wins} défaite(s) contre lui`)).join('');

  const mapDeepDiveHtml = renderMapDeepDive(games, uid, mapsStats);

  return `
    <div class="analytics-section">
      <div class="section-title">Séries</div>
      <div class="streak-row">
        <div class="streak-card"><div class="streak-label">Série en cours</div><div class="streak-value" style="color:${streakColor}">${streakLabel}</div></div>
        <div class="streak-card"><div class="streak-label">Meilleure série de victoires</div><div class="streak-value" style="color:var(--win)">${streaks.bestWin}</div></div>
        <div class="streak-card"><div class="streak-label">Pire série de défaites</div><div class="streak-value" style="color:var(--loss)">${streaks.worstLoss}</div></div>
      </div>
    </div>

    <div class="analytics-section">
      <div class="section-title">Rating (façon HLTV)</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:12px;">
        Inspiré du Rating HLTV (CS) : combine kills, morts, dégâts, assists et score en un seul
        chiffre plutôt que de se fier au seul K/D. 1.00 = performance moyenne parmi tous les
        joueurs croisés sur la période (même population que le classement Comparatif), au-dessus
        = meilleur que la moyenne. EVA n'a pas de round/KAST/trade-kill comme CS, donc c'est une
        adaptation par partie — pas le calcul HLTV exact.
      </div>
      ${rating.rating == null ? `<div class="hl-empty">Pas assez de données sur la période pour calculer un rating.</div>` : `
      <div class="streak-card" style="max-width:220px;margin-bottom:14px;">
        <div class="streak-label">Rating</div>
        <div class="streak-value ${rating.rating>=1?'kd-good':'kd-bad'}" style="font-size:32px;">${rating.rating.toFixed(2)}</div>
      </div>
      <div class="profile-grid">
        <div class="cell"><div class="label">Kills</div><div class="value ${rating.components.kills>=1?'kd-good':'kd-bad'}">×${rating.components.kills.toFixed(2)}</div></div>
        <div class="cell"><div class="label">Morts (inversé)</div><div class="value ${rating.components.deaths>=1?'kd-good':'kd-bad'}">×${rating.components.deaths.toFixed(2)}</div></div>
        <div class="cell"><div class="label">Dégâts</div><div class="value ${rating.components.dmg>=1?'kd-good':'kd-bad'}">×${rating.components.dmg.toFixed(2)}</div></div>
        <div class="cell"><div class="label">Assists</div><div class="value ${rating.components.assists>=1?'kd-good':'kd-bad'}">×${rating.components.assists.toFixed(2)}</div></div>
        <div class="cell"><div class="label">Score</div><div class="value ${rating.components.score>=1?'kd-good':'kd-bad'}">×${rating.components.score.toFixed(2)}</div></div>
      </div>`}
    </div>

    <div class="analytics-section">
      <div class="section-title">Score d'impact</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:12px;">
        Pondère le taux de victoire et la contribution aux dégâts d'équipe (par rapport à ta
        juste part vu la taille de l'équipe) — mesure l'impact sur les victoires, pas la
        performance individuelle brute (voir "Efficacité" plus bas pour ça).
      </div>
      <div class="streak-row">
        <div class="streak-card"><div class="streak-label">Score d'impact</div><div class="streak-value" style="font-size:28px;color:var(--gold);">${impact.score}<span style="font-size:14px;color:var(--muted);">/100</span></div></div>
        <div class="streak-card"><div class="streak-label">Taux de victoire</div><div class="streak-value">${impact.winrate}%</div></div>
        <div class="streak-card"><div class="streak-label">Indice de contribution</div><div class="streak-value">${impact.contribIndex == null ? NA : `${impact.contribIndex}/100`}</div></div>
      </div>
      ${impact.contribIndex == null ? `<div style="color:var(--muted);font-size:11px;margin-top:10px;">
        Contribution non disponible : aucune partie de la période n'a d'assignation d'équipe exploitable — score basé sur le winrate seul.
      </div>` : ''}
    </div>

    <div class="analytics-section">
      <div class="section-title">Efficacité</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:12px;">
        Des stats normalisées par mort plutôt que par partie — plus fiables pour comparer des
        périodes ou des joueurs qui n'ont pas le même nombre de parties.
      </div>
      <div class="profile-grid">
        <div class="cell"><div class="label">KDA ((kills+assists)/morts)</div><div class="value">${efficiency.kda}</div></div>
        <div class="cell"><div class="label">Dégâts par mort</div><div class="value">${efficiency.dmgPerDeath.toLocaleString('fr-FR')}</div></div>
        <div class="cell"><div class="label">Précision moyenne</div><div class="value">${efficiency.avgAccuracy}%</div></div>
        <div class="cell"><div class="label">Assists moyens / partie</div><div class="value">${efficiency.avgAssists}</div></div>
        <div class="cell"><div class="label">Taux de MVP (rang 1 équipe)</div><div class="value" style="color:var(--gold)">${rankStats.mvpRate}%</div></div>
      </div>
    </div>

    <div class="analytics-section">
      <div class="section-title-row">
        <div class="section-title">Progression partie par partie — ${METRIC_LABELS[state.profileMetric]}</div>
        <div class="metric-toggle" id="metricToggle">
          <button class="btn small ${state.profileMetric==='kd'?'active':''}" data-metric="kd">K/D</button>
          <button class="btn small ${state.profileMetric==='dmg'?'active':''}" data-metric="dmg">Dégâts</button>
          <button class="btn small ${state.profileMetric==='score'?'active':''}" data-metric="score">Score</button>
          <button class="btn small ${state.profileMetric==='acc'?'active':''}" data-metric="acc">Précision</button>
        </div>
      </div>
      <div class="chart-card">${trendChart}</div>
    </div>

    <div class="analytics-section">
      <div class="section-title">Rythme de victoires (moyenne glissante sur ${wrWindow} parties)</div>
      <div class="chart-card">${wrChart}</div>
    </div>

    <div class="analytics-grid-2">
      <div>
        <div class="section-title">Classement dans l'équipe</div>
        <div style="color:var(--muted);font-size:12px;margin-bottom:12px;">
          Ta place au classement de ta propre équipe à la fin de chaque partie (rang 1 = meilleur score de l'équipe).
        </div>
        <div class="bar-list">${rankRows}</div>
      </div>
      <div>
        <div class="section-title">Contribution au score d'équipe</div>
        <div class="chart-card">${contribChart}</div>
      </div>
    </div>

    <div class="analytics-section">
      <div class="section-title">Contribution aux dégâts d'équipe</div>
      <div class="chart-card">${dmgContribChart}</div>
    </div>

    <div class="analytics-section">
      <div class="section-title">Dégâts — vue d'équipe</div>
      <div class="streak-row">
        <div class="streak-card"><div class="streak-label">Dégâts moyens de l'équipe / partie</div><div class="streak-value">${dmgTeamStats.avgTeamDmg.toLocaleString('fr-FR')}</div></div>
        <div class="streak-card"><div class="streak-label">Tes dégâts moyens / partie</div><div class="streak-value">${dmgTeamStats.avgPlayerDmg.toLocaleString('fr-FR')}</div></div>
        <div class="streak-card"><div class="streak-label">Ta part moyenne des dégâts</div><div class="streak-value" style="color:var(--gold)">${dmgTeamStats.avgContribPct}%</div></div>
      </div>
    </div>

    <div class="analytics-grid-2">
      <div>
        <div class="section-title">Performance par carte</div>
        <div style="color:var(--muted);font-size:11px;margin-bottom:10px;">Clique une carte pour un focus dédié (courbe, meilleures/pires parties).</div>
        <div class="bar-list">${mapRows}</div>
      </div>
      <div>
        <div class="section-title">Performance par mode</div>
        <div class="bar-list">${modeRows}</div>
      </div>
    </div>

    ${mapDeepDiveHtml}

    <div class="analytics-grid-2">
      <div>
        <div class="section-title">Meilleures synergies</div>
        <div style="color:var(--muted);font-size:12px;margin-bottom:12px;">
          Coéquipiers avec qui tu gagnes le plus (au moins ${duoNemesis.minGames} parties ensemble).
        </div>
        <div class="bar-list">${duoRows || '<div class="hl-empty">Pas assez de coéquipiers récurrents sur la période.</div>'}</div>
      </div>
      <div>
        <div class="section-title">Némésis</div>
        <div style="color:var(--muted);font-size:12px;margin-bottom:12px;">
          Adversaires contre qui tu gagnes le moins (au moins ${duoNemesis.minGames} parties affrontées) — le % est ton taux de victoire contre eux.
        </div>
        <div class="bar-list">${nemesisRows || '<div class="hl-empty">Pas assez d\'adversaires récurrents sur la période.</div>'}</div>
      </div>
    </div>

    <div class="analytics-grid-2">
      <div>
        <div class="section-title">Jours de la semaine</div>
        <div class="bar-list">${dowRows}</div>
      </div>
      <div>
        <div class="section-title">Moment de la journée</div>
        <div class="bar-list">${todRows}</div>
      </div>
    </div>

    ${fatigueRows ? `
    <div class="analytics-section">
      <div class="section-title">Effet de fatigue en séance</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:12px;">
        Winrate et K/D moyen selon la position de la partie dans la séance (1ère, 2e, 3e...) —
        utile pour repérer si la performance baisse après plusieurs parties d'affilée.
      </div>
      <div class="bar-list">${fatigueRows}</div>
    </div>` : ''}

    <div class="analytics-section">
      <div class="section-title">Répartition du ratio K/D</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:12px;">
        Nombre de parties par tranche de K/D — indique la régularité (parties concentrées sur
        une tranche) ou l'irrégularité (parties dispersées sur plusieurs tranches) des performances.
      </div>
      <div class="bar-list">${kdDistRows}</div>
    </div>

    <div class="analytics-section">
      <div class="section-title">Meilleures & pires performances</div>
      <div class="highlight-grid">
        ${highlightCard('Meilleur ratio K/D', bw.bestKD, e => e.kd.toFixed(2), 'var(--gold)')}
        ${highlightCard('Plus gros dégâts', bw.bestDmg, e => e.val.toLocaleString('fr-FR'), 'var(--gold)')}
        ${highlightCard('Meilleur score', bw.bestScore, e => e.val.toLocaleString('fr-FR'), 'var(--gold)')}
        ${highlightCard('Partie la plus difficile', bw.worst, e => e.val.toLocaleString('fr-FR')+' pts', 'var(--loss)')}
      </div>
    </div>
  `;
}

// Branche les évènements du Profil : choix de métrique du graphique, sélection d'une carte pour le focus dédié, choix du joueur de comparaison.
export function attachProfileMetricButtons() {
  const toggle = document.getElementById('metricToggle');
  if (toggle) {
    toggle.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        state.profileMetric = btn.dataset.metric;
        renderProfil();
      });
    });
  }

  document.querySelectorAll('[data-map-select]').forEach(row => {
    row.addEventListener('click', () => {
      const name = row.dataset.mapSelect;
      state.mapDeepDiveSelection = state.mapDeepDiveSelection === name ? null : name;
      renderProfil();
      if (state.mapDeepDiveSelection) {
        const panel = document.getElementById('mapDeepDive');
        if (panel && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
  const closeBtn = document.getElementById('mapDeepDiveClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      state.mapDeepDiveSelection = null;
      renderProfil();
    });
  }
}
