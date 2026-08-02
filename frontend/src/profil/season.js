import { fmtDate, fmtDateShort, fmtDelta, fmtHM } from '../format.js';
import { displaySeasonId, normalizeSnapshotStats, snapshotSeasonId } from '../seasons.js';

const NA = '<span style="color:var(--muted);">n/d</span>';

// Les stats de saison repartent de 0 à chaque saison : le cumul de la DERNIÈRE capture
// d'une saison représente donc le total de cette saison entière. Pour "Toutes les
// saisons" (aucune saison sélectionnée, aucune période filtrée), `snaps` contient les
// captures de TOUTES les saisons connues, pas une seule — on ne peut pas se contenter
// de lire la dernière capture globale (ça ne montrerait que la saison en cours). On
// regroupe donc par saison, on garde la dernière capture de chaque groupe (son total),
// puis on additionne ces totaux entre saisons. `snaps` est trié asc par capturedAt (voir
// api.js), donc un simple Map écrasé dans l'ordre suffit à garder le dernier par groupe.
function latestPerSeason(snaps) {
  const bySeason = new Map();
  for (const s of snaps) {
    const sid = snapshotSeasonId(s);
    const key = sid != null ? `s:${sid}` : `u:${s.capturedAt}`;
    bySeason.set(key, s);
  }
  return [...bySeason.values()];
}

// Additionne les compteurs cumulés de plusieurs saisons (chacune représentée par sa
// dernière capture). bestKillStreak/bestInflictedDamage sont des records, pas des
// sommes : on garde le max toutes saisons confondues plutôt que d'additionner.
function sumSeasonTotals(seasonSnaps) {
  const items = seasonSnaps.map(normalizeSnapshotStats).filter(Boolean);
  const hasPlaytime = items.length > 0 && items.every(i => i.hasPlaytime);
  const hasDamage = items.length > 0 && items.every(i => i.hasDamage);
  return items.reduce((acc, it) => ({
    gameCount: acc.gameCount + it.gameCount,
    gameVictoryCount: acc.gameVictoryCount + it.gameVictoryCount,
    gameDefeatCount: acc.gameDefeatCount + it.gameDefeatCount,
    gameDrawCount: acc.gameDrawCount + it.gameDrawCount,
    kills: acc.kills + it.kills,
    deaths: acc.deaths + it.deaths,
    assists: acc.assists + it.assists,
    traveledDistance: acc.traveledDistance + it.traveledDistance,
    gameTime: acc.gameTime + it.gameTime,
    inflictedDamage: acc.inflictedDamage + it.inflictedDamage,
    bestKillStreak: Math.max(acc.bestKillStreak, it.bestKillStreak),
    bestInflictedDamage: Math.max(acc.bestInflictedDamage, it.bestInflictedDamage),
    hasPlaytime, hasDamage,
  }), {
    gameCount: 0, gameVictoryCount: 0, gameDefeatCount: 0, gameDrawCount: 0,
    kills: 0, deaths: 0, assists: 0, traveledDistance: 0, gameTime: 0, inflictedDamage: 0,
    bestKillStreak: 0, bestInflictedDamage: 0, hasPlaytime, hasDamage,
  });
}

// ================= PROFIL : carte de saison (depuis les snapshots getPlayerByUserId) =================
// `baseline` (optionnel) est la dernière capture connue AVANT le début de la période
// filtrée (voir seasonCardBaseline() dans seasons.js). Les stats de saison sont des
// compteurs cumulés, pas des deltas : sans soustraire cette ligne de base, filtrer sur
// "7 derniers jours" n'aurait presque aucun effet visible ici (le cumul depuis le
// début de la saison resterait affiché tel quel). Quand baseline est fourni, la carte
// affiche donc "ce qui a été gagné pendant la période", pas le cumul brut.
export function renderSeasonCard(snaps, baseline) {
  const latest = snaps[snaps.length - 1];
  const exp = latest.experience || {};
  const seasonIds = new Set(snaps.map(snapshotSeasonId));
  // Pas de baseline (donc pas de fenêtre de date restreinte à une saison) et plusieurs
  // saisons présentes dans la sélection = c'est le cas "Toutes les saisons" : agréger
  // plutôt que ne montrer que la dernière capture (qui ne reflète que la saison en cours).
  const isAllSeasons = !baseline && seasonIds.size > 1;

  const cur = isAllSeasons ? sumSeasonTotals(latestPerSeason(snaps)) : (normalizeSnapshotStats(latest) || {
    gameCount: 0, gameVictoryCount: 0, gameDefeatCount: 0, gameDrawCount: 0,
    kills: 0, deaths: 0, assists: 0, bestKillStreak: 0, traveledDistance: 0,
    gameTime: 0, inflictedDamage: 0, bestInflictedDamage: 0, hasPlaytime: false, hasDamage: false,
  });
  const base = (!isAllSeasons && baseline) ? normalizeSnapshotStats(baseline) : null;
  // Le temps de jeu / les dégâts ne sont disponibles que si les DEUX bornes du delta
  // les ont (le nouveau format d'EVA, battleArenaStatistics, ne les fournit plus du tout).
  const hasPlaytime = cur.hasPlaytime && (!base || base.hasPlaytime);
  const hasDamage = cur.hasDamage && (!base || base.hasDamage);

  const gameCount = cur.gameCount - (base ? base.gameCount : 0);
  const gameVictoryCount = cur.gameVictoryCount - (base ? base.gameVictoryCount : 0);
  const gameDefeatCount = cur.gameDefeatCount - (base ? base.gameDefeatCount : 0);
  const gameDrawCount = cur.gameDrawCount - (base ? base.gameDrawCount : 0);
  const kills = cur.kills - (base ? base.kills : 0);
  const deaths = cur.deaths - (base ? base.deaths : 0);
  const assists = cur.assists - (base ? base.assists : 0);
  const traveledDistance = cur.traveledDistance - (base ? base.traveledDistance : 0);
  const gameTime = hasPlaytime ? cur.gameTime - (base ? base.gameTime : 0) : null;
  const inflictedDamage = hasDamage ? cur.inflictedDamage - (base ? base.inflictedDamage : 0) : null;
  // bestKillStreak/bestInflictedDamage sont des records cumulés (max depuis le début
  // de la saison), pas des sommes : leur "delta" est le record BATTU pendant la
  // période (0 si aucun nouveau record n'a été établi durant la fenêtre filtrée).
  const bestKillStreak = Math.max(0, cur.bestKillStreak - (base ? base.bestKillStreak : 0));
  const bestInflictedDamage = hasDamage ? Math.max(0, cur.bestInflictedDamage - (base ? base.bestInflictedDamage : 0)) : null;

  const winrate = gameCount ? Math.round((gameVictoryCount / gameCount) * 100) : 0;
  const hours = gameTime != null ? (gameTime / 3600).toFixed(1) : null;
  const distanceKm = traveledDistance ? (traveledDistance / 1000).toFixed(1) : '0';
  const avgDistance = gameCount ? Math.round(traveledDistance / gameCount) : 0;
  const kd = deaths ? (kills / deaths).toFixed(2) : kills.toFixed(2);

  return `
    <div class="profile-card">
      <div class="profile-top">
        <div>
          <div class="profile-name">${latest.user.displayName || latest.user.username || '?'}</div>
          <div class="profile-sub">
            ${latest.user.username || ''} · ${isAllSeasons ? `Toutes les saisons (${seasonIds.size})` : `Saison ${displaySeasonId(snapshotSeasonId(latest)) ?? '?'}`}
            ${latest.seasonPass && latest.seasonPass.active ? ' · <span class="badge-pass">Pass actif</span>' : ''}
            ${base ? ' · <span style="color:var(--gold);">stats de la période sélectionnée</span>' : ''}
            · ${isAllSeasons ? 'dernière capture le' : 'capturé le'} ${fmtDate(latest.capturedAt)}
          </div>
        </div>
        <div class="profile-level">
          <div class="lvl-num">Niveau ${exp.level ?? '?'}</div>
          <div class="xp-bar"><div class="xp-fill" style="width:${exp.levelProgressionPercentage || 0}%"></div></div>
          <div class="xp-label">${(exp.experience ?? 0).toLocaleString('fr-FR')} / ${(exp.experienceForNextLevel ?? 0).toLocaleString('fr-FR')} XP</div>
        </div>
      </div>

      <div class="profile-grid">
        <div class="cell"><div class="label">Parties</div><div class="value">${gameCount}</div></div>
        <div class="cell"><div class="label">V / D / Nul</div><div class="value" style="font-size:16px;"><span class="win">${gameVictoryCount}</span> / <span class="loss">${gameDefeatCount}</span> / ${gameDrawCount}</div></div>
        <div class="cell"><div class="label">Taux de victoire</div><div class="value">${winrate}%</div></div>
        <div class="cell"><div class="label">Temps de jeu</div><div class="value">${hours != null ? hours + ' h' : NA}</div></div>

        <div class="cell"><div class="label">Kills / Morts / Assists</div><div class="value" style="font-size:16px;">${kills} / ${deaths} / ${assists}</div></div>
        <div class="cell"><div class="label">Ratio K/D</div><div class="value">${kd}</div></div>
        <div class="cell"><div class="label">${base ? 'Record battu (série de kills)' : 'Meilleure série de kills'}</div><div class="value">${bestKillStreak}</div></div>
        <div class="cell"><div class="label">Dégâts totaux infligés</div><div class="value">${inflictedDamage != null ? inflictedDamage.toLocaleString('fr-FR') : NA}</div></div>

        <div class="cell"><div class="label">${base ? 'Record battu (dégâts, 1 partie)' : 'Meilleurs dégâts (1 partie)'}</div><div class="value">${bestInflictedDamage != null ? bestInflictedDamage.toLocaleString('fr-FR') : NA}</div></div>
        <div class="cell"><div class="label">Distance parcourue</div><div class="value">${distanceKm} km</div></div>
        <div class="cell"><div class="label">Distance moy. / partie</div><div class="value">${avgDistance} m</div></div>
        <div class="cell"><div class="label">Snapshots capturés</div><div class="value">${snaps.length}</div></div>
      </div>
      ${!hasDamage || !hasPlaytime ? `<div style="color:var(--muted);font-size:11px;margin-top:10px;">
        Temps de jeu et dégâts ne sont plus renvoyés par le profil EVA depuis son dernier changement d'API — non disponibles tant qu'EVA ne les republie pas.
      </div>` : ''}
    </div>`;
}

// Construit le tableau d'évolution entre chaque capture successive du profil (toutes les stats de saison, dont la distance parcourue).
export function renderEvolutionTable(snaps) {
  let rows = '';
  for (let i = 1; i < snaps.length; i++) {
    const prevExp = snaps[i-1].experience || {};
    const curExp = snaps[i].experience || {};
    const prevSid = snapshotSeasonId(snaps[i-1]);
    const curSid = snapshotSeasonId(snaps[i]);

    // Les stats de saison repartent de 0 à chaque nouvelle saison : si les deux captures
    // n'appartiennent pas à la même saison, un delta brut donnerait des nombres négatifs
    // absurdes (compteurs remis à zéro) plutôt qu'une vraie régression. On le signale
    // explicitement au lieu de calculer une évolution qui n'a pas de sens ici.
    if (prevSid != null && curSid != null && prevSid !== curSid) {
      rows += `
      <tr>
        <td class="name-cell">${fmtDateShort(snaps[i-1].capturedAt)} → ${fmtDateShort(snaps[i].capturedAt)}</td>
        <td class="num" colspan="14" style="text-align:left;color:var(--muted);font-style:italic;">
          Nouvelle saison (${displaySeasonId(prevSid)} → ${displaySeasonId(curSid)}) — compteurs remis à zéro, pas de delta calculé.
        </td>
      </tr>`;
      continue;
    }

    const prev = normalizeSnapshotStats(snaps[i-1]);
    const cur = normalizeSnapshotStats(snaps[i]);
    if (!prev || !cur) continue; // capture sans aucune stat exploitable (fragment isolé) — rien à comparer
    // Le nouveau format d'EVA (battleArenaStatistics) ne fournit plus le temps de jeu ni
    // les dégâts : un delta n'a de sens que si les DEUX captures les fournissent.
    const hasPlaytime = prev.hasPlaytime && cur.hasPlaytime;
    const hasDamage = prev.hasDamage && cur.hasDamage;

    const dGames = cur.gameCount - prev.gameCount;
    const dWins = cur.gameVictoryCount - prev.gameVictoryCount;
    const dLoss = cur.gameDefeatCount - prev.gameDefeatCount;
    const dDraw = cur.gameDrawCount - prev.gameDrawCount;
    const dKills = cur.kills - prev.kills;
    const dDeaths = cur.deaths - prev.deaths;
    const dAssists = cur.assists - prev.assists;
    const dDistance = cur.traveledDistance - prev.traveledDistance;
    const dBestStreak = cur.bestKillStreak - prev.bestKillStreak;
    const dGameTime = hasPlaytime ? cur.gameTime - prev.gameTime : null;
    const dDmg = hasDamage ? cur.inflictedDamage - prev.inflictedDamage : null;
    const dBestDmg = hasDamage ? cur.bestInflictedDamage - prev.bestInflictedDamage : null;
    const dLevel = (curExp.level||0) - (prevExp.level||0);
    const dXp = (curExp.experience||0) - (prevExp.experience||0);

    const wr = dGames > 0 ? Math.round((dWins/dGames)*100) : 0;
    const kd = dDeaths > 0 ? (dKills/dDeaths).toFixed(2) : dKills.toFixed(2);

    rows += `
      <tr>
        <td class="name-cell">${fmtDateShort(snaps[i-1].capturedAt)} → ${fmtDateShort(snaps[i].capturedAt)}</td>
        <td class="num">${fmtDelta(dGames)}</td>
        <td class="num"><span class="win">${fmtDelta(dWins)}</span> / <span class="loss">${fmtDelta(dLoss)}</span>${dDraw ? ` / ${fmtDelta(dDraw)} nul` : ''}</td>
        <td class="num ${wr>=50?'kd-good':'kd-bad'}">${wr}%</td>
        <td class="num ${kd>=1?'kd-good':'kd-bad'}">${kd}</td>
        <td class="num">${fmtDelta(dKills)}</td>
        <td class="num">${fmtDelta(dDeaths)}</td>
        <td class="num">${fmtDelta(dAssists)}</td>
        <td class="num">${dDmg != null ? fmtDelta(dDmg) : NA}</td>
        <td class="num" style="color:var(--gold);font-weight:600;">${fmtDelta(dDistance/1000, dDistance ? 1 : 0)} km</td>
        <td class="num">${dGameTime != null ? fmtHM(dGameTime) : NA}</td>
        <td class="num">${dLevel ? fmtDelta(dLevel) : '—'}</td>
        <td class="num">${fmtDelta(dXp)}</td>
        <td class="num">${dBestStreak>0 ? fmtDelta(dBestStreak) : '—'}</td>
        <td class="num">${dBestDmg==null ? NA : (dBestDmg>0 ? fmtDelta(dBestDmg) : '—')}</td>
      </tr>`;
  }
  return `
    <div style="color:var(--muted);font-size:12px;margin-top:22px;margin-bottom:8px;">
      Évolution entre chaque capture successive du profil de ce joueur — toutes les stats de la saison, dont la distance parcourue.
    </div>
    <div class="table-scroll"><table class="roster">
      <thead><tr>
        <th>Période entre captures</th>
        <th class="num">Δ Parties</th>
        <th class="num">V / D</th>
        <th class="num">Winrate</th>
        <th class="num">K/D</th>
        <th class="num">Δ Kills</th>
        <th class="num">Δ Morts</th>
        <th class="num">Δ Assists</th>
        <th class="num">Δ Dégâts</th>
        <th class="num">Δ Distance</th>
        <th class="num">Δ Temps de jeu</th>
        <th class="num">Δ Niveau</th>
        <th class="num">Δ XP</th>
        <th class="num">Δ Meilleure série</th>
        <th class="num">Δ Record dégâts</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}
