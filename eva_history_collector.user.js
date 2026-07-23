// ==UserScript==
// @name         EVA — Collecteur d'historique et de stats
// @namespace    eva-history-collector
// @version      2.2
// @description  Capture automatiquement l'historique de parties (cursorAfterhGameHistory) et les statistiques de profil (getPlayerByUserId, ta page de profil connectée — getPublicPlayerByUsername reste géré si les pages publiques refonctionnent un jour côté EVA) depuis les requêtes réseau de la page EVA, et permet de les exporter en JSON pour la visionneuse.
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
// 4. Va sur ta page d'historique de parties et sur TA page de profil connectée
//    (celle qui affiche tes propres stats de saison quand tu es identifié —
//    requête getPlayerByUserId), laisse-la charger / fais défiler pour déclencher
//    les requêtes suivantes. Les pages de profil PUBLIC d'un autre joueur
//    (getPublicPlayerByUsername) ne fonctionnent plus côté EVA.gg au moment
//    d'écrire ce script : le script sait toujours les reconnaître si elles
//    remarchent un jour, mais pour l'instant ta propre page connectée est la
//    seule source fiable de stats de saison.
// 5. Un panneau apparaît en bas à droite avec le nombre de parties et de profils
//    capturés. Clique sur "Télécharger JSON" pour récupérer le fichier.
// 6. Importe ce fichier dans la visionneuse HTML (eva_game_viewer.html).
//
// IMPORTANT — pourquoi le script ne doit tourner QUE sur le site EVA :
// avec "@match *://*/*", Tampermonkey injecte ce script sur CHAQUE site que tu
// visites, y compris Google. Comme le script intercepte fetch()/XMLHttpRequest
// pour repérer les bonnes requêtes, le laisser actif partout revient à observer
// (inutilement) tout le trafic de tous les sites, ce qui peut ressembler à une
// activité en boucle dans les devtools. Le filtre HOST_HINT ci-dessous coupe court
// à ça : le script se désactive intégralement (aucun hook posé) si le nom de domaine
// de la page ne contient pas "eva".
//
// Le script stocke tout dans le localStorage du site visité, donc si tu reviens
// plus tard (même après un import), les nouvelles données se fusionnent sans
// doublon (parties dédupliquées par id, profils par contenu de stats).
// Comme les stats de profil sont des totaux cumulés, capture-les régulièrement
// (chaque session par ex.) pour que la visionneuse puisse tracer leur évolution.

(function () {
  'use strict';

  // Le script tourne sur "*://*/*" pour que Tampermonkey puisse l'injecter avant que
  // tu aies réglé la bonne adresse. Mais pour éviter qu'il n'intercepte le trafic
  // d'AUTRES sites (Google, etc.), il se désactive tout seul si le nom de domaine
  // de la page ne correspond pas à ce filtre. Adapte HOST_HINT si besoin (ex: "app.eva.gg").
  const HOST_HINT = 'eva';
  if (!location.hostname.toLowerCase().includes(HOST_HINT)) {
    return; // page non-EVA : le script ne fait strictement rien, aucun hook n'est posé.
  }

  const GAMES_KEY = 'eva_history_collector_data';
  const STATS_KEY = 'eva_history_collector_playerstats';
  const MARKER_GAMES = 'cursorAfterhGameHistory';
  const MARKER_STATS = 'getPlayerByUserId';
  const MARKER_STATS_PUBLIC = 'getPublicPlayerByUsername';

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
  function mergeGameNodes(nodes) {
    if (!Array.isArray(nodes)) return 0;
    let added = 0;
    nodes.forEach((n) => {
      if (n && n.id != null) {
        if (!games[n.id]) added++;
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

  // ---------- player stats ----------
  function extractPlayerStats(payload) {
    try {
      const list = Array.isArray(payload) ? payload : [payload];
      let all = [];
      list.forEach((item) => {
        const d = item && item.data ? item.data : null;
        // "getPlayerByUserId" = ta page de profil connectée (authentifiée) — la seule
        // source de stats de saison actuellement fonctionnelle sur EVA.gg.
        // "getPublicPlayerByUsername" = page publique du profil d'un autre joueur ;
        // cassée côté EVA.gg pour l'instant, mais on garde la reconnaissance au cas où
        // elle refonctionne un jour. Même forme de données pour les deux.
        const p = d ? (d.getPlayerByUserId || d.getPublicPlayerByUsername) : null;
        if (p && p.user && p.user.id != null) all.push(p);
      });
      return all.length ? all : null;
    } catch (e) {
      return null;
    }
  }

  function mergePlayerStat(raw) {
    const uid = raw.user.id;
    const snapshot = {
      capturedAt: new Date().toISOString(),
      user: { id: raw.user.id, username: raw.user.username, displayName: raw.user.displayName },
      seasonPass: raw.seasonPass || null,
      experience: raw.experience || null,
      statistics: raw.statistics || null,
    };
    if (!stats[uid]) stats[uid] = [];
    const list = stats[uid];
    const sig = JSON.stringify(snapshot.statistics) + JSON.stringify(snapshot.experience);
    const last = list[list.length - 1];
    const lastSig = last ? JSON.stringify(last.statistics) + JSON.stringify(last.experience) : null;
    if (sig === lastSig) return false; // identique à la dernière capture, on ignore
    list.push(snapshot);
    saveJSON(STATS_KEY, stats);
    return true;
  }

  // ---------- dispatch ----------
  function handleText(text) {
    if (!text) return;
    const hasGames = text.indexOf(MARKER_GAMES) !== -1;
    const hasStats = text.indexOf(MARKER_STATS) !== -1 || text.indexOf(MARKER_STATS_PUBLIC) !== -1;
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
      if (nodes) addedGames = mergeGameNodes(nodes);
    }
    if (hasStats) {
      const players = extractPlayerStats(json);
      if (players) players.forEach((p) => { if (mergePlayerStat(p)) addedStats++; });
    }
    if (addedGames || addedStats) {
      updatePanel();
      const parts = [];
      if (addedGames) parts.push(`+${addedGames} partie(s)`);
      if (addedStats) parts.push(`+${addedStats} profil(s)`);
      flashPanel(parts.join(' · '));
    }
  }

  // ---------- interception fetch() ----------
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then((response) => {
      try {
        response.clone().text().then(handleText).catch(() => {});
      } catch (e) {}
      return response;
    });
  };

  // ---------- interception XMLHttpRequest ----------
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try { handleText(this.responseText); } catch (e) {}
    });
    return origSend.apply(this, args);
  };

  // ---------- panneau flottant ----------
  let panel, gamesCountEl, statsCountEl, statusEl;

  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = `
      position:fixed; bottom:16px; right:16px; z-index:2147483647;
      background:#11151f; color:#e7ebf3; font-family:-apple-system,Segoe UI,Roboto,sans-serif;
      font-size:13px; border:1px solid #2b3348; border-radius:10px; padding:12px 14px;
      box-shadow:0 6px 24px rgba(0,0,0,.45); width:220px; user-select:none;
    `;
    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
        <span>🎮</span><span>EVA Collector</span>
      </div>
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
    `;
    document.documentElement.appendChild(panel);
    gamesCountEl = panel.querySelector('#eva-collector-games');
    statsCountEl = panel.querySelector('#eva-collector-stats');
    statusEl = panel.querySelector('#eva-collector-status');

    panel.querySelector('#eva-collector-download').addEventListener('click', downloadJSON);
    panel.querySelector('#eva-collector-copy').addEventListener('click', copyJSON);
    panel.querySelector('#eva-collector-clear').addEventListener('click', () => {
      games = {}; stats = {};
      saveJSON(GAMES_KEY, games);
      saveJSON(STATS_KEY, stats);
      updatePanel();
      flashPanel('Tout a été vidé');
    });
  }

  function updatePanel() {
    if (!gamesCountEl) return;
    gamesCountEl.textContent = Object.keys(games).length;
    const totalSnapshots = Object.values(stats).reduce((sum, arr) => sum + arr.length, 0);
    statsCountEl.textContent = totalSnapshots;
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
    buildPanel();
    updatePanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
