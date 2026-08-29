// ============================================================================
// EVA-Debrief — Collecteur automatique (extension)
// content-main-world.js — hook fetch()/XMLHttpRequest sur le site EVA.
//
// Port du cœur de capture de eva_history_collector.user.js (userscript), avec deux
// différences volontaires liées au fait que ceci tourne comme une vraie extension
// Manifest V3 plutôt qu'un userscript Tampermonkey :
//
// 1. PAS de pageWindow/unsafeWindow. Ce script est déclaré "world": "MAIN" dans
//    manifest.json — il tourne DÉJÀ dans le vrai contexte JS de la page (c'est
//    l'équivalent extension de unsafeWindow, mais natif). `window`/`fetch`/
//    `XMLHttpRequest` ici SONT ceux que le site EVA utilise réellement. Ne PAS
//    réintroduire une indirection façon userscript — elle n'a aucune utilité ici et
//    ce serait se prémunir contre un problème qui n'existe pas dans ce contexte.
//
// 2. PAS d'accès à chrome.runtime ici. C'est la contrepartie du monde MAIN : un
//    script qui y tourne est traité comme "du code de page", pas comme une extension
//    — chrome.runtime y est undefined. Ce script ne peut donc PAS parler directement
//    au service worker. À la place, il capture tout en mémoire (jamais dans
//    localStorage : ce serait écrire dans le stockage du site EVA lui-même) et
//    dispatch un CustomEvent sur `document` dès qu'il y a du delta — c'est
//    content-isolated.js (world par défaut, garde chrome.runtime) qui écoute cet
//    événement et relaie vers le service worker (voir ce fichier).
// ============================================================================

(function () {
  'use strict';

  const HOST_HINT = 'eva';
  if (!location.hostname.toLowerCase().includes(HOST_HINT)) {
    return; // page non-EVA : ce script ne fait strictement rien, aucun hook n'est posé.
  }

  const MARKER_GAMES = 'cursorAfterhGameHistory';
  const MARKER_STATS_OWNED = 'getPlayerByUserId';

  // ---------------------------------------------------------------------------
  // Requêtes réécrites : identique au userscript (voir eva_history_collector.user.js
  // pour l'historique complet de pourquoi ces champs précis sont redemandés).
  // ---------------------------------------------------------------------------
  const QUERY_REPLACEMENTS = {
    HistoryBa: `query HistoryBa($seasonId: Int!, $cursor: Int, $limit: Int) {
      cursorAfterhGameHistory(seasonId: $seasonId, cursor: $cursor, limit: $limit, game: BattleArena) {
        nodes {
          id
          createdAt
          mode { id identifier category __typename }
          data {
            teamOne { score name __typename }
            teamTwo { score name __typename }
            __typename
          }
          players {
            id
            userId
            isMvp
            data {
              outcome
              kills
              deaths
              assists
              score
              inflictedDamage
              firedAccuracy
              team
              rank
              niceName
              __typename
            }
            __typename
          }
          map { id name __typename }
          __typename
        }
        hasNextPage
        nextCursor
        __typename
      }
    }`,

    UseProfileUserOwned: `query UseProfileUserOwned($userId: Int!, $seasonId: Int!) {
      getPlayerByUserId(userId: $userId) {
        user { id username displayName __typename }
        experience(seasonId: $seasonId) {
          level
          levelProgressionPercentage
          experienceForNextLevel
          experience
          __typename
        }
        seasonPass { active __typename }
        battleArenaStatistics(seasonId: $seasonId) {
          data {
            gameTime
            winRate
            killDeathRatio
            gameCount
            killsAverage
            kills
            deaths
            assists
            bestKillStreak
            mvpCount
            traveledDistance
            __typename
          }
          __typename
        }
        __typename
      }
    }`,
  };

  // games/stats : accumulateur EN MÉMOIRE seulement (jamais localStorage, voir
  // l'en-tête de ce fichier) — sert uniquement à la dédup DANS cette page chargée ;
  // repart de zéro à chaque rechargement de page, contrairement au userscript. C'est
  // acceptable ici : le but de cette extension est le push automatique en continu,
  // pas un export/historique local à conserver entre sessions.
  const games = {};
  const stats = {};

  // ---------- games ----------
  function mergeGameNodes(nodes, seasonId) {
    if (!Array.isArray(nodes)) return { added: 0, items: [] };
    let added = 0;
    const items = [];
    nodes.forEach((n) => {
      if (n && n.id != null) {
        if (!games[n.id]) { added++; items.push(n); }
        if (seasonId != null) n.seasonId = seasonId;
        games[n.id] = n;
      }
    });
    return { added, items };
  }

  function extractGameNodes(payload) {
    try {
      const list = Array.isArray(payload) ? payload : [payload];
      let all = [];
      list.forEach((item) => {
        const nodes = item && item.data && item.data.cursorAfterhGameHistory
          ? item.data.cursorAfterhGameHistory.nodes
          : null;
        if (Array.isArray(nodes)) all = all.concat(nodes);
      });
      return all.length ? all : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- player stats ----------
  function extractPlayerStats(payload) {
    try {
      const list = Array.isArray(payload) ? payload : [payload];
      let all = [];
      list.forEach((item) => {
        const d = item && item.data ? item.data : null;
        const p = d ? d.getPlayerByUserId : null;
        if (p && p.user && p.user.id != null && (p.battleArenaStatistics || p.statistics)) all.push(p);
      });
      return all.length ? all : null;
    } catch (e) {
      return null;
    }
  }

  function mergePlayerStat(raw, seasonId) {
    const uid = raw.user.id;
    const snapshot = {
      capturedAt: new Date().toISOString(),
      seasonId: seasonId != null ? seasonId : null,
      user: { id: raw.user.id, username: raw.user.username, displayName: raw.user.displayName },
      seasonPass: raw.seasonPass || null,
      experience: raw.experience || null,
      statistics: raw.statistics || null,
      battleArenaStatistics: raw.battleArenaStatistics || null,
    };
    if (!stats[uid]) stats[uid] = [];
    const list = stats[uid];
    const sig = seasonId + '|' + JSON.stringify(snapshot.statistics) + JSON.stringify(snapshot.battleArenaStatistics) + JSON.stringify(snapshot.experience);
    const alreadyExists = list.some((s) => ((s.seasonId != null ? s.seasonId : null) + '|' + JSON.stringify(s.statistics) + JSON.stringify(s.battleArenaStatistics) + JSON.stringify(s.experience)) === sig);
    if (alreadyExists) return null;
    list.push(snapshot);
    return snapshot;
  }

  // ---------- dispatch ----------
  function handleText(text, meta) {
    if (!text) return;
    meta = meta || { allowStats: true, seasonId: null };
    const hasGames = text.indexOf(MARKER_GAMES) !== -1;
    const hasStats = meta.allowStats !== false
      && text.indexOf(MARKER_STATS_OWNED) !== -1
      && (text.indexOf('"battleArenaStatistics"') !== -1 || text.indexOf('"statistics"') !== -1);
    if (!hasGames && !hasStats) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return; // réponse partielle ou non-JSON
    }
    let newGameItems = [], newStatItems = [];
    if (hasGames) {
      const nodes = extractGameNodes(json);
      if (nodes) newGameItems = mergeGameNodes(nodes, meta.seasonId).items;
    }
    if (hasStats) {
      const players = extractPlayerStats(json);
      if (players) {
        players.forEach((p) => {
          const snapshot = mergePlayerStat(p, meta.seasonId);
          if (snapshot) newStatItems.push(snapshot);
        });
      }
    }
    if (newGameItems.length || newStatItems.length) {
      // Seul pont possible vers content-isolated.js (voir l'en-tête de ce fichier) :
      // un CustomEvent sur `document`, partagé entre les deux mondes d'une même page.
      document.dispatchEvent(new CustomEvent('eva-debrief-capture', {
        detail: { nodes: newGameItems, playerStats: newStatItems },
      }));
    }
  }

  // ---------- interception réseau : jamais de modification de la requête du site,
  // un second appel séparé est déclenché à côté (voir eva_history_collector.user.js
  // pour l'historique complet de cette approche et pourquoi la réécriture en place a
  // été abandonnée). ----------
  const lastEnrichedAt = {};
  const ENRICH_THROTTLE_MS = 5000;

  function tryFireEnriched(url, init) {
    if (!init || typeof init.body !== 'string') return;
    let parsed;
    try {
      parsed = JSON.parse(init.body);
    } catch (e) {
      return;
    }
    const opName = parsed && parsed.operationName;
    if (!opName || !QUERY_REPLACEMENTS[opName]) return;

    const throttleKey = opName + '|' + JSON.stringify(parsed.variables || {});
    const now = Date.now();
    if (lastEnrichedAt[throttleKey] && (now - lastEnrichedAt[throttleKey]) < ENRICH_THROTTLE_MS) return;
    lastEnrichedAt[throttleKey] = now;

    const enrichedBody = Object.assign({}, parsed, { query: QUERY_REPLACEMENTS[opName] });
    const enrichedInit = Object.assign({}, init, { body: JSON.stringify(enrichedBody) });
    const requestSeasonId = parsed.variables && parsed.variables.seasonId != null ? parsed.variables.seasonId : null;

    origFetch.call(window, url, enrichedInit)
      .then((res) => res.text())
      .then((text) => {
        const allowStats = opName !== 'UseProfileUserOwned' || requestSeasonId != null;
        handleText(text, { allowStats, seasonId: requestSeasonId });
      })
      .catch(() => { /* échec ponctuel, sans conséquence : on retentera à la prochaine requête du site */ });
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (url) tryFireEnriched(url, init);
    } catch (e) { /* si le déclenchement échoue, la requête du site part quand même normalement */ }
    return origFetch.call(this, input, init);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', function () {
      try { handleText(this.responseText, { allowStats: true, seasonId: null }); } catch (e) {}
    });
    return origSend.call(this, body);
  };
})();
