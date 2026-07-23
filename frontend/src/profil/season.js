import { fmtDate, fmtDateShort, fmtDelta, fmtHM } from '../format.js';
import { displaySeasonId } from '../seasons.js';

// ================= PROFIL : carte de saison (depuis les snapshots getPlayerByUserId) =================
export function renderSeasonCard(snaps) {
  const latest = snaps[snaps.length - 1];
  const exp = latest.experience || {};
  const stat = (latest.statistics && latest.statistics.data) || {};
  const winrate = stat.gameCount ? Math.round((stat.gameVictoryCount / stat.gameCount) * 100) : 0;
  const hours = stat.gameTime ? (stat.gameTime / 3600).toFixed(1) : '0';
  const distanceKm = stat.traveledDistance ? (stat.traveledDistance / 1000).toFixed(1) : '0';
  const avgDistance = stat.traveledDistanceAverage ? Math.round(stat.traveledDistanceAverage) : 0;

  return `
    <div class="profile-card">
      <div class="profile-top">
        <div>
          <div class="profile-name">${latest.user.displayName || latest.user.username || '?'}</div>
          <div class="profile-sub">
            ${latest.user.username || ''} · Saison ${displaySeasonId(exp.seasonId) ?? '?'}
            ${latest.seasonPass && latest.seasonPass.active ? ' · <span class="badge-pass">Pass actif</span>' : ''}
            · capturé le ${fmtDate(latest.capturedAt)}
          </div>
        </div>
        <div class="profile-level">
          <div class="lvl-num">Niveau ${exp.level ?? '?'}</div>
          <div class="xp-bar"><div class="xp-fill" style="width:${exp.levelProgressionPercentage || 0}%"></div></div>
          <div class="xp-label">${(exp.experience ?? 0).toLocaleString('fr-FR')} / ${(exp.experienceForNextLevel ?? 0).toLocaleString('fr-FR')} XP</div>
        </div>
      </div>

      <div class="profile-grid">
        <div class="cell"><div class="label">Parties</div><div class="value">${stat.gameCount ?? 0}</div></div>
        <div class="cell"><div class="label">V / D / Nul</div><div class="value" style="font-size:16px;"><span class="win">${stat.gameVictoryCount ?? 0}</span> / <span class="loss">${stat.gameDefeatCount ?? 0}</span> / ${stat.gameDrawCount ?? 0}</div></div>
        <div class="cell"><div class="label">Taux de victoire</div><div class="value">${winrate}%</div></div>
        <div class="cell"><div class="label">Temps de jeu</div><div class="value">${hours} h</div></div>

        <div class="cell"><div class="label">Kills / Morts / Assists</div><div class="value" style="font-size:16px;">${stat.kills ?? 0} / ${stat.deaths ?? 0} / ${stat.assists ?? 0}</div></div>
        <div class="cell"><div class="label">Ratio K/D</div><div class="value">${(stat.deaths ? (stat.kills||0)/stat.deaths : (stat.kills||0)).toFixed(2)}</div></div>
        <div class="cell"><div class="label">Meilleure série de kills</div><div class="value">${stat.bestKillStreak ?? 0}</div></div>
        <div class="cell"><div class="label">Dégâts totaux infligés</div><div class="value">${(stat.inflictedDamage ?? 0).toLocaleString('fr-FR')}</div></div>

        <div class="cell"><div class="label">Meilleurs dégâts (1 partie)</div><div class="value">${(stat.bestInflictedDamage ?? 0).toLocaleString('fr-FR')}</div></div>
        <div class="cell"><div class="label">Distance parcourue</div><div class="value">${distanceKm} km</div></div>
        <div class="cell"><div class="label">Distance moy. / partie</div><div class="value">${avgDistance} m</div></div>
        <div class="cell"><div class="label">Snapshots capturés</div><div class="value">${snaps.length}</div></div>
      </div>
    </div>`;
}

// Construit le tableau d'évolution entre chaque capture successive du profil (toutes les stats de saison, dont la distance parcourue).
export function renderEvolutionTable(snaps) {
  let rows = '';
  for (let i = 1; i < snaps.length; i++) {
    const prevExp = snaps[i-1].experience || {};
    const curExp = snaps[i].experience || {};

    // Les stats de saison repartent de 0 à chaque nouvelle saison : si les deux captures
    // n'appartiennent pas à la même saison, un delta brut donnerait des nombres négatifs
    // absurdes (compteurs remis à zéro) plutôt qu'une vraie régression. On le signale
    // explicitement au lieu de calculer une évolution qui n'a pas de sens ici.
    if (prevExp.seasonId != null && curExp.seasonId != null && prevExp.seasonId !== curExp.seasonId) {
      rows += `
      <tr>
        <td class="name-cell">${fmtDateShort(snaps[i-1].capturedAt)} → ${fmtDateShort(snaps[i].capturedAt)}</td>
        <td class="num" colspan="14" style="text-align:left;color:var(--muted);font-style:italic;">
          Nouvelle saison (${displaySeasonId(prevExp.seasonId)} → ${displaySeasonId(curExp.seasonId)}) — compteurs remis à zéro, pas de delta calculé.
        </td>
      </tr>`;
      continue;
    }

    const prev = (snaps[i-1].statistics && snaps[i-1].statistics.data) || {};
    const cur = (snaps[i].statistics && snaps[i].statistics.data) || {};

    const dGames = (cur.gameCount||0) - (prev.gameCount||0);
    const dWins = (cur.gameVictoryCount||0) - (prev.gameVictoryCount||0);
    const dLoss = (cur.gameDefeatCount||0) - (prev.gameDefeatCount||0);
    const dDraw = (cur.gameDrawCount||0) - (prev.gameDrawCount||0);
    const dKills = (cur.kills||0) - (prev.kills||0);
    const dDeaths = (cur.deaths||0) - (prev.deaths||0);
    const dAssists = (cur.assists||0) - (prev.assists||0);
    const dDmg = (cur.inflictedDamage||0) - (prev.inflictedDamage||0);
    const dDistance = (cur.traveledDistance||0) - (prev.traveledDistance||0);
    const dGameTime = (cur.gameTime||0) - (prev.gameTime||0);
    const dBestStreak = (cur.bestKillStreak||0) - (prev.bestKillStreak||0);
    const dBestDmg = (cur.bestInflictedDamage||0) - (prev.bestInflictedDamage||0);
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
        <td class="num">${fmtDelta(dDmg)}</td>
        <td class="num" style="color:var(--gold);font-weight:600;">${fmtDelta(dDistance/1000, dDistance ? 1 : 0)} km</td>
        <td class="num">${fmtHM(dGameTime)}</td>
        <td class="num">${dLevel ? fmtDelta(dLevel) : '—'}</td>
        <td class="num">${fmtDelta(dXp)}</td>
        <td class="num">${dBestStreak>0 ? fmtDelta(dBestStreak) : '—'}</td>
        <td class="num">${dBestDmg>0 ? fmtDelta(dBestDmg) : '—'}</td>
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
