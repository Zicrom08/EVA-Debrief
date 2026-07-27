// ==UserScript==
// @name         EVA — Collecteur d'historique et de stats
// @namespace    eva-history-collector
// @version      9.1
// @description  Capture l'historique de parties et les stats de ton profil (dégâts, précision, distance...) depuis le site EVA. Réécrit activement les requêtes du site pour redemander les champs manquants, et ne garde que les captures de profil filtrées par saison (évite les doublons en boucle).
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// INSTALLATION
// 1. Installe l'extension "Tampermonkey" dans ton navigateur (Chrome, Firefox, Edge...).
// 2. Crée un nouveau script, colle tout ce fichier dedans, sauvegarde.
// 3. (Recommandé) Remplace la ligne "@match" tout en haut par l'adresse exacte du
//    site EVA, par exemple app.eva.gg — c'est plus propre que le filtre HOST_HINT
//    ci-dessous, qui sert de garde-fou de secours.
// 4. Va sur ta page d'historique de parties et sur ta page de profil, laisse-les
//    charger / fais défiler pour déclencher les requêtes suivantes.
// 5. Un panneau apparaît en bas à droite avec le nombre de parties et de profils
//    capturés. Clique sur "Télécharger JSON" pour récupérer le fichier.
// 6. Importe ce fichier dans la visionneuse.
//
// COMMENT CE SCRIPT RÉCUPÈRE LES CHAMPS QU'EVA A CESSÉ DE DEMANDER (depuis la v4.0)
// Courant juillet 2026, EVA a changé les requêtes GraphQL que le site envoie
// lui-même : les champs score/inflictedDamage/firedAccuracy/team/rank/niceName
// (historique), le score de chaque équipe, et tout le bloc statistics (profil :
// dégâts totaux, distance parcourue, meilleure série...) ne sont plus demandés
// par défaut. Les données existent toujours côté serveur (vérifié), le site a
// juste arrêté de les redemander.
//
// ⚠️ ERREUR CORRIGÉE EN v8.0 — NE PAS RÉINTRODUIRE : les versions 4.0 à 7.0
// modifiaient la requête du site EN PLACE avant qu'elle ne parte (même
// operationName, mais un contenu différent). Ça provoquait des requêtes en
// boucle infinie qui ont fait bannir temporairement des comptes — probablement
// parce que le client GraphQL du site (Apollo/React Query) attend une réponse
// de la forme exacte qu'il a demandée pour mettre à jour son cache interne, et
// qu'une réponse de forme différente déclenchait une erreur suivie d'une
// re-tentative automatique, en boucle, à très haute fréquence.
//
// Depuis la v8.0 : la requête du site n'est JAMAIS modifiée, elle part toujours
// strictement intacte. À la place, ce script déclenche EN PLUS un DEUXIÈME appel
// réseau totalement séparé (mêmes URL/méthode/headers, donc la même
// authentification, mais avec notre requête enrichie) — le site ne voit jamais
// cette réponse-là et ne peut donc jamais boucler dessus. Cet appel
// supplémentaire est limité à une fois toutes les 5 secondes par type de
// requête, pour rester discret même si le site interroge son profil très
// fréquemment (observé en pratique).
//
// Si EVA change encore le schéma plus tard (nouveaux noms de champs, nouvelles
// requêtes), ce script redeviendra incomplet de la même façon — utilise
// eva_network_inspector.user.js pour diagnostiquer si ça se reproduit.
//
// PANNEAU RÉDUCTIBLE (v9.1)
// Le script tourne sur tout le domaine EVA (voir HOST_HINT plus bas), pas seulement sur
// les pages d'historique/profil — le panneau peut donc gêner ailleurs sur le site. Clique
// sur son en-tête (ou le bouton "–"/"+") pour le réduire à un simple bandeau avec les
// compteurs ; l'état réduit/déplié est mémorisé (même mécanisme que games/stats) et
// survit aux rechargements de page, donc pas besoin de le refermer à chaque navigation.
//
// À PROPOS DE LA CAPTURE DE TON PROPRE PROFIL (getPlayerByUserId)
// Une version précédente de ce script excluait volontairement la capture du
// profil personnel authentifié suite à un bug de perte de données. C'est
// redevenu nécessaire : c'est la seule requête qui redonne accès au bloc
// "statistics" (dégâts, distance, etc.) de TON profil. Le mécanisme de capture
// a changé entre-temps (réécriture active de requête plutôt que simple lecture
// passive), donc le bug d'origine ne devrait plus se reproduire — mais reste
// attentif en l'utilisant.
//
// PROFILS PUBLICS (retiré en v5.0)
// EVA a retiré les pages de profil public — il n'existe donc plus de requête
// "getPublicPlayerByUsername" à intercepter. Ce script ne capture plus que ton
// propre profil authentifié. Les stats des autres joueurs que tu croises
// continuent d'être disponibles normalement via l'historique de parties
// (kills/morts/assists/dégâts/précision par partie), simplement plus via une
// page de profil dédiée.
//
// IMPORTANT — pourquoi le script ne doit tourner QUE sur le site EVA :
// avec "@match *://*/*", Tampermonkey injecte ce script sur CHAQUE site que tu
// visites, y compris Google. Le filtre HOST_HINT ci-dessous coupe court à ça :
// le script se désactive intégralement (aucun hook posé) si le nom de domaine
// de la page ne contient pas "eva".
//
// Le script stocke tout dans le localStorage du site visité. Les parties sont
// dédupliquées par id, les profils par empreinte de contenu — donc même si une
// page de profil se recharge automatiquement toutes les secondes (observé sur
// certaines pages du site), une seule capture est gardée tant que les chiffres
// n'ont pas changé. Pas de risque de gonfler le stockage avec des doublons.

(function () {
  'use strict';

  const HOST_HINT = 'eva';
  if (!location.hostname.toLowerCase().includes(HOST_HINT)) {
    return; // page non-EVA : le script ne fait strictement rien, aucun hook n'est posé.
  }

  const GAMES_KEY = 'eva_history_collector_data';
  const STATS_KEY = 'eva_history_collector_playerstats';
  const MINIMIZED_KEY = 'eva_history_collector_minimized';
  const MARKER_GAMES = 'cursorAfterhGameHistory';
  const MARKER_STATS_OWNED = 'getPlayerByUserId';

  // ---------------------------------------------------------------------------
  // Requêtes réécrites : on garde le même operationName et les mêmes variables
  // que la requête d'origine du site (pagination, seasonId...), seul le corps
  // de la "query" GraphQL change pour redemander les champs manquants.
  // ---------------------------------------------------------------------------
  const QUERY_REPLACEMENTS = {
    // Liste paginée de l'historique — désormais complète en un seul appel :
    // avant, "score" nécessitait d'ouvrir chaque partie individuellement.
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

    // Profil personnel — redemande le bloc "statistics" complet (dégâts,
    // distance parcourue, meilleure série...) disparu de la requête par défaut.
    UseProfileUserOwned: `query UseProfileUserOwned($userId: Int!, $seasonId: Int) {
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
        statistics(seasonId: $seasonId) {
          data {
            gameCount
            gameTime
            gameVictoryCount
            gameDefeatCount
            gameDrawCount
            inflictedDamage
            bestInflictedDamage
            kills
            deaths
            assists
            killDeathRatio
            killsByDeaths
            traveledDistance
            traveledDistanceAverage
            bestKillStreak
          }
          __typename
        }
        __typename
      }
    }`,
  };

  // Note : la logique de réécriture de requête et d'extraction du seasonId est
  // maintenant directement dans tryFireEnriched() plus bas — on ne mute plus jamais
  // la requête du site en place (voir explication à ce sujet dans tryFireEnriched).

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* quota or blocked storage: fail silently, capture still works in-memory */
    }
  }

  let games = loadJSON(GAMES_KEY, {});          // { [gameId]: gameNode }
  let stats = loadJSON(STATS_KEY, {});          // { [userId]: [snapshot, ...] sorted asc }

  // ---------- games ----------
  function mergeGameNodes(nodes, seasonId) {
    if (!Array.isArray(nodes)) return 0;
    let added = 0;
    nodes.forEach((n) => {
      if (n && n.id != null) {
        if (!games[n.id]) added++;
        // La partie elle-même ne renvoie pas son seasonId dans la réponse de l'API — on
        // l'attache nous-mêmes à partir de la variable de la requête (voir tryFireEnriched).
        // Ça permet à la visionneuse de filtrer/regrouper l'historique par saison.
        if (seasonId != null) n.seasonId = seasonId;
        games[n.id] = n;
      }
    });
    if (added > 0) saveJSON(GAMES_KEY, games);
    return added;
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

  // ---------- player stats (profil personnel uniquement — les profils publics n'existent plus sur EVA) ----------
  function extractPlayerStats(payload) {
    try {
      const list = Array.isArray(payload) ? payload : [payload];
      let all = [];
      list.forEach((item) => {
        const d = item && item.data ? item.data : null;
        // On exige la présence du bloc "statistics" : d'autres requêtes du site (ex:
        // getPlayerExperience, DashboardOverviewOwned) utilisent aussi getPlayerByUserId
        // mais sans les stats complètes — on ne veut pas les capturer comme un "profil".
        const p = d ? d.getPlayerByUserId : null;
        if (p && p.user && p.user.id != null && p.statistics) all.push(p);
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
    };
    if (!stats[uid]) stats[uid] = [];
    const list = stats[uid];
    // Le seasonId fait partie de l'empreinte : au tout début d'une nouvelle saison, les
    // stats peuvent momentanément ressembler à une capture déjà vue (ex: 0 partie partout),
    // sans le seasonId dans la signature ce serait pris à tort pour un doublon et ignoré.
    const sig = seasonId + '|' + JSON.stringify(snapshot.statistics) + JSON.stringify(snapshot.experience);
    // On compare à TOUTES les captures déjà stockées, pas juste la dernière — la page de
    // profil EVA alterne entre plusieurs variantes de requête (saison en cours / toutes
    // saisons confondues) qui reviennent en boucle très rapidement, et une comparaison
    // "à la dernière seulement" laisse passer ce cas A-B-A-B-A-B sans jamais rien filtrer.
    const alreadyExists = list.some((s) => ((s.seasonId != null ? s.seasonId : null) + '|' + JSON.stringify(s.statistics) + JSON.stringify(s.experience)) === sig);
    if (alreadyExists) return false;
    list.push(snapshot);
    list.sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    saveJSON(STATS_KEY, stats);
    return true;
  }

  // ---------- dispatch ----------
  function handleText(text, meta) {
    if (!text) return;
    meta = meta || { allowStats: true, seasonId: null };
    const hasGames = text.indexOf(MARKER_GAMES) !== -1;
    const hasStats = meta.allowStats !== false
      && text.indexOf(MARKER_STATS_OWNED) !== -1 && text.indexOf('"statistics"') !== -1;
    if (!hasGames && !hasStats) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return; // réponse partielle ou non-JSON
    }
    let addedGames = 0, addedStats = 0;
    if (hasGames) {
      const nodes = extractGameNodes(json);
      if (nodes) addedGames = mergeGameNodes(nodes, meta.seasonId);
    }
    if (hasStats) {
      const players = extractPlayerStats(json);
      if (players) players.forEach((p) => { if (mergePlayerStat(p, meta.seasonId)) addedStats++; });
    }
    if (addedGames || addedStats) {
      updatePanel();
      const parts = [];
      if (addedGames) parts.push(`+${addedGames} partie(s)`);
      if (addedStats) parts.push(`+${addedStats} profil(s)`);
      flashPanel(parts.join(' · '));
    }
  }

  // On ne modifie plus JAMAIS la requête du site en place (voir explication plus haut) —
  // à la place, on la laisse partir intacte, et on déclenche EN PLUS un appel séparé,
  // avec les mêmes URL/méthode/headers (donc la même authentification) mais notre requête
  // enrichie. Ce deuxième appel ne repasse jamais par le code du site : le site ne voit
  // jamais sa réponse et ne peut donc jamais boucler dessus.
  const lastEnrichedAt = {}; // operationName -> timestamp (ms) du dernier appel enrichi
  const ENRICH_THROTTLE_MS = 5000; // au moins 5 secondes entre deux appels enrichis pour une même opération

  function tryFireEnriched(url, init) {
    if (!init || typeof init.body !== 'string') return;
    let parsed;
    try {
      parsed = JSON.parse(init.body);
    } catch (e) {
      return; // pas un body JSON GraphQL
    }
    const opName = parsed && parsed.operationName;
    if (!opName || !QUERY_REPLACEMENTS[opName]) return;

    const now = Date.now();
    if (lastEnrichedAt[opName] && (now - lastEnrichedAt[opName]) < ENRICH_THROTTLE_MS) return;
    lastEnrichedAt[opName] = now;

    const enrichedBody = Object.assign({}, parsed, { query: QUERY_REPLACEMENTS[opName] });
    const enrichedInit = Object.assign({}, init, { body: JSON.stringify(enrichedBody) });

    // Ni les parties ni les captures de profil ne renvoient leur propre seasonId dans la
    // réponse — on récupère donc le seasonId directement depuis les VARIABLES de la
    // requête envoyée (le site le connaît forcément, puisque c'est lui qui filtre par
    // saison) et on l'attache nous-mêmes à ce qu'on stocke. Pour HistoryBa, le site exige
    // toujours un seasonId précis (il n'affiche que les parties de la saison sélectionnée),
    // donc cette valeur est fiable à chaque appel.
    const requestSeasonId = parsed.variables && parsed.variables.seasonId != null ? parsed.variables.seasonId : null;

    origFetch.call(window, url, enrichedInit)
      .then((res) => res.text())
      .then((text) => {
        const allowStats = opName !== 'UseProfileUserOwned' || requestSeasonId != null;
        handleText(text, { allowStats, seasonId: requestSeasonId });
      })
      .catch(() => { /* échec ponctuel, sans conséquence : on retentera à la prochaine requête du site */ });
  }

  // ---------- interception fetch() : ne touche jamais à la requête du site, en déclenche une deuxième à côté ----------
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (url) tryFireEnriched(url, init);
    } catch (e) { /* si le déclenchement échoue, la requête du site part quand même normalement */ }
    return origFetch.call(this, input, init);
  };

  // ---------- interception XMLHttpRequest : capture passive uniquement (EVA n'utilise que fetch()
  // en pratique, ceci est un filet de sécurité qui ne modifie jamais rien) ----------
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', function () {
      try { handleText(this.responseText, { allowStats: true, seasonId: null }); } catch (e) {}
    });
    return origSend.call(this, body);
  };

  // ---------- panneau flottant ----------
  // Réductible : utile pour le laisser en place mais hors du chemin quand on navigue
  // ailleurs sur le site (le script tourne sur tout le domaine, pas juste historique/profil —
  // voir HOST_HINT plus haut). L'état réduit/déplié est mémorisé dans localStorage (même
  // clé que games/stats, donc partagé entre onglets et persistant d'un rechargement à
  // l'autre) pour ne pas avoir à re-réduire à chaque nouvelle page.
  let panel, gamesCountEl, statsCountEl, statusEl, bodyEl, badgeEl, toggleBtn;
  let minimized = loadJSON(MINIMIZED_KEY, false);

  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = `
      position:fixed; bottom:16px; right:16px; z-index:2147483647;
      background:#11151f; color:#e7ebf3; font-family:-apple-system,Segoe UI,Roboto,sans-serif;
      font-size:13px; border:1px solid #2b3348; border-radius:10px;
      box-shadow:0 6px 24px rgba(0,0,0,.45); user-select:none;
    `;
    panel.innerHTML = `
      <div id="eva-collector-header" style="font-weight:700;padding:12px 14px;display:flex;align-items:center;gap:6px;cursor:pointer;">
        <span>🎮</span><span style="flex:1;">EVA Collector</span>
        <span id="eva-collector-badge" style="display:none;color:#8892a6;font-weight:400;font-size:11px;white-space:nowrap;"></span>
        <button id="eva-collector-toggle" title="Réduire" style="background:none;border:none;color:#8892a6;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;">–</button>
      </div>
      <div id="eva-collector-body" style="padding:0 14px 14px;">
        <div style="display:flex;gap:14px;margin-bottom:8px;">
          <div>
            <div id="eva-collector-games" style="font-size:22px;font-weight:700;line-height:1;">0</div>
            <div style="color:#8892a6;font-size:11px;">parties</div>
          </div>
          <div>
            <div id="eva-collector-stats" style="font-size:22px;font-weight:700;line-height:1;">0</div>
            <div style="color:#8892a6;font-size:11px;">profils captés</div>
          </div>
        </div>
        <div id="eva-collector-status" style="font-size:11px;color:#3ddc84;min-height:14px;margin-bottom:8px;"></div>
        <button id="eva-collector-download" style="width:100%;margin-bottom:6px;padding:7px;border:none;border-radius:6px;background:#4f9dff;color:#0a0d14;font-weight:700;cursor:pointer;">Télécharger JSON</button>
        <button id="eva-collector-copy" style="width:100%;margin-bottom:6px;padding:7px;border:none;border-radius:6px;background:#232a3a;color:#e7ebf3;cursor:pointer;">Copier le JSON</button>
        <button id="eva-collector-clear" style="width:100%;padding:7px;border:none;border-radius:6px;background:#3a1c22;color:#ff9aa2;cursor:pointer;">Tout vider</button>
      </div>
    `;
    document.documentElement.appendChild(panel);
    gamesCountEl = panel.querySelector('#eva-collector-games');
    statsCountEl = panel.querySelector('#eva-collector-stats');
    statusEl = panel.querySelector('#eva-collector-status');
    bodyEl = panel.querySelector('#eva-collector-body');
    badgeEl = panel.querySelector('#eva-collector-badge');
    toggleBtn = panel.querySelector('#eva-collector-toggle');

    panel.querySelector('#eva-collector-download').addEventListener('click', downloadJSON);
    panel.querySelector('#eva-collector-copy').addEventListener('click', copyJSON);
    panel.querySelector('#eva-collector-clear').addEventListener('click', () => {
      games = {}; stats = {};
      saveJSON(GAMES_KEY, games);
      saveJSON(STATS_KEY, stats);
      updatePanel();
      flashPanel('Tout a été vidé');
    });
    // Le header entier bascule l'état réduit (pas juste le petit bouton — plus facile à
    // cliquer), sauf clic sur un bouton qu'il pourrait contenir un jour (stopPropagation
    // pas nécessaire aujourd'hui vu qu'aucun bouton n'est dans le header, mais le
    // toggle explicite reste le point d'entrée principal pour la lisibilité).
    panel.querySelector('#eva-collector-header').addEventListener('click', () => setMinimized(!minimized));

    applyMinimizedState();
    updatePanel();
  }

  function setMinimized(value) {
    minimized = value;
    saveJSON(MINIMIZED_KEY, minimized);
    applyMinimizedState();
  }

  function applyMinimizedState() {
    if (!panel) return;
    bodyEl.style.display = minimized ? 'none' : 'block';
    toggleBtn.textContent = minimized ? '+' : '–';
    toggleBtn.title = minimized ? 'Agrandir' : 'Réduire';
    badgeEl.style.display = minimized ? 'inline' : 'none';
  }

  function updatePanel() {
    if (!gamesCountEl) return;
    const gameCount = Object.keys(games).length;
    const totalSnapshots = Object.values(stats).reduce((sum, arr) => sum + arr.length, 0);
    gamesCountEl.textContent = gameCount;
    statsCountEl.textContent = totalSnapshots;
    if (badgeEl) badgeEl.textContent = `${gameCount} · ${totalSnapshots}`;
  }

  function flashPanel(msg) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    clearTimeout(flashPanel._t);
    flashPanel._t = setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
  }

  function getExportPayload() {
    const nodes = Object.values(games).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const playerStats = [];
    Object.values(stats).forEach((arr) => playerStats.push(...arr));
    playerStats.sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    return { nodes, playerStats };
  }

  function downloadJSON() {
    const blob = new Blob([JSON.stringify(getExportPayload(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eva-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function copyJSON() {
    const text = JSON.stringify(getExportPayload());
    navigator.clipboard
      .writeText(text)
      .then(() => flashPanel('Copié dans le presse-papiers'))
      .catch(() => flashPanel('Échec de la copie (autorise le presse-papiers)'));
  }

  function init() {
    buildPanel(); // appelle déjà updatePanel() une fois le panneau construit
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
