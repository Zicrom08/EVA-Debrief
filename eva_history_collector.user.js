// ==UserScript==
// @name         EVA — Collecteur d'historique et de stats
// @namespace    eva-history-collector
// @version      10.2
// @description  Capture l'historique de parties et les stats de ton profil (dégâts, précision, distance...) depuis le site EVA, et les pousse automatiquement vers ton instance EVA-Debrief si configuré (voir "PONT AUTOMATIQUE" plus bas). Réécrit activement les requêtes du site pour redemander les champs manquants, et ne garde que les captures de profil filtrées par saison (évite les doublons en boucle).
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

// INSTALLATION
// 1. Installe l'extension "Tampermonkey" dans ton navigateur (Chrome, Firefox, Edge...) — ou,
//    sur mobile, Kiwi Browser (Android, supporte les extensions Chrome) ou l'app "Userscripts"
//    (iOS/Safari) : ce script fonctionne à l'identique sur les trois, aucune adaptation requise.
// 2. Crée un nouveau script, colle tout ce fichier dedans, sauvegarde.
// 3. (Recommandé) Remplace la ligne "@match" tout en haut par l'adresse exacte du
//    site EVA, par exemple app.eva.gg — c'est plus propre que le filtre HOST_HINT
//    ci-dessous, qui sert de garde-fou de secours.
// 4. Va sur ta page d'historique de parties et sur ta page de profil, laisse-les
//    charger / fais défiler pour déclencher les requêtes suivantes.
// 5. Un panneau apparaît en bas à droite avec le nombre de parties et de profils
//    capturés. Clique sur "Télécharger JSON" pour récupérer le fichier.
// 6. Importe ce fichier dans la visionneuse — OU configure le pont automatique
//    (voir juste en dessous) pour ne plus jamais avoir à le faire manuellement.
//
// PONT AUTOMATIQUE VERS EVA-DEBRIEF (v10.0)
// Une fois configuré (menu Tampermonkey "Configurer EVA-Debrief", ou le bouton "⚙️ Configurer"
// du panneau si ce menu est peu accessible sur ton navigateur mobile), ce script envoie
// automatiquement en arrière-plan chaque nouvelle partie/profil capturé vers ton instance
// EVA-Debrief (POST /api/import, authentifié par un jeton d'import personnel généré depuis
// l'onglet "+ Importer" d'EVA-Debrief — jamais ton mot de passe EVA, et ce jeton ne permet
// QUE de pousser des parties, rien d'autre). Utilise GM_xmlhttpRequest : contourne CORS
// nativement (aucune configuration serveur supplémentaire nécessaire), et n'envoie jamais les
// cookies du site EVA lui-même. Entièrement optionnel : sans configuration, rien ne change —
// "Télécharger JSON"/"Copier le JSON" restent disponibles et fonctionnent à l'identique. Un
// échec de push (jeton révoqué, backend injoignable...) ne fait jamais planter la capture
// locale : juste un avertissement en console, la capture continue normalement et reste
// disponible via le téléchargement manuel.
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
// LE CHAMP "statistics" A DISPARU DU SCHÉMA (v9.3) — PLUS AUCUN PROFIL CAPTÉ
// Constaté via eva_network_inspector.user.js : la requête enrichie ci-dessous, qui
// redemandait `statistics(seasonId: $seasonId)`, se prend maintenant un 400 avec
// "Cannot query field \"statistics\" on type \"Player\"." — ce n'est plus un jeu de
// champs réduit comme lors du changement de juillet 2026 (voir plus haut), le champ
// est intégralement retiré du schéma GraphQL, la requête est rejetée à la validation.
// Cet échec passait totalement inaperçu : handleText() n'affiche/ne journalise rien
// pour une réponse qui ne contient ni "cursorAfterhGameHistory" ni "getPlayerByUserId"
// + "statistics" (un corps d'erreur `{"errors":[...]}` ne contient aucun des deux —
// le nom de champ dans le message est échappé en `\"statistics\"`, pas le littéral
// `"statistics"`) — d'où l'absence totale de capture de profil, sans aucune erreur
// visible dans le panneau. Les vraies stats de saison transitent maintenant par
// `battleArenaStatistics(seasonId: $seasonId)` (vu fonctionner sur l'opération
// DashboardOverviewOwned du site, avec `$seasonId: Int!` non-nullable — c'est
// d'ailleurs pour ça que le type de la variable ci-dessous est passé de `Int` à
// `Int!`, un simple `Int` s'y ferait rejeter à la validation). UseProfileUserOwned
// redemande donc ce bloc à la place de "statistics" ; extractPlayerStats/
// mergePlayerStat/handleText ont été mis à jour en conséquence. La forme stockée
// (`snapshot.battleArenaStatistics`) est déjà comprise par normalizeSnapshotStats()
// côté visionneuse (frontend/src/seasons.js), qui la traitait déjà comme le format
// "réduit" pour les anciennes captures — gameTime et les champs de dégâts restent
// donc marqués absents (hasPlaytime/hasDamage à false) même si ce champ précis en
// renvoie un (gameTime) : non exploité pour l'instant, cf. seasons.js.
//
// THROTTLE PAR VARIABLES, PAS PAR OPÉRATION (v9.2)
// Le garde-fou "5 secondes entre deux appels enrichis" était jusque-là indexé uniquement
// sur le nom de l'opération (ex: "HistoryBa"), pas sur ses variables. Or HistoryBa est
// rappelée une fois par page d'historique avec un cursor différent à chaque fois : si le
// site tirait deux pages à moins de 5s d'intervalle (défilement rapide), la deuxième page
// se faisait silencieusement absorber par le throttle et n'était donc jamais capturée
// (la réponse d'origine, non enrichie, du site n'est de toute façon jamais lue — voir
// plus bas). La clé de throttle inclut maintenant les variables de la requête.
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

  // ⚠️ RÉGRESSION CORRIGÉE EN v10.1 — NE PAS RÉINTRODUIRE : dès qu'un script Tampermonkey
  // déclare AU MOINS UN @grant (même juste GM_getValue), Tampermonkey l'exécute dans un
  // contexte "sandbox" isolé où `window` n'est PLUS le vrai window de la page — c'est
  // différent du mode `@grant none` (utilisé jusqu'en v9.3), où le script tournait
  // directement dans le contexte de la page. Conséquence concrète : `window.fetch = ...`
  // remplaçait bien le fetch que LE SITE appelle lui-même en `@grant none`, mais dans le
  // contexte sandboxé (depuis l'ajout des @grant du pont automatique en v10.0), cette même
  // ligne ne fait que remplacer le fetch d'un window ISOLÉ que le site ne voit jamais — le
  // hook s'installe sans la moindre erreur, mais n'intercepte plus RIEN (capture totalement
  // silencieuse à zéro, confirmé en usage réel). `unsafeWindow` est la référence spéciale
  // fournie par Tampermonkey (et les autres gestionnaires compatibles GM — Violentmonkey,
  // l'app Userscripts iOS...) qui pointe explicitement vers le VRAI window de la page,
  // même depuis un contexte sandboxé — c'est donc lui qu'il faut utiliser pour tout ce qui
  // doit agir sur ce que la page voit (fetch, XMLHttpRequest), quels que soient les autres
  // @grant déclarés. Repli sur `window` si `unsafeWindow` n'existe pas (gestionnaire qui ne
  // sandboxe pas, ou qui ne fournit pas cette référence) : comportement alors identique à
  // avant, jamais pire.
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const GAMES_KEY = 'eva_history_collector_data';
  const STATS_KEY = 'eva_history_collector_playerstats';
  const MINIMIZED_KEY = 'eva_history_collector_minimized';
  const CLOSED_KEY = 'eva_history_collector_closed';
  const POSITION_KEY = 'eva_history_collector_position';
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

    // Profil personnel — redemande le bloc de stats de bataille disparu de la requête
    // par défaut. "statistics" n'existe plus du tout dans le schéma (voir note v9.3
    // plus haut) : on redemande "battleArenaStatistics" à la place, seul bloc dont on
    // a confirmé qu'il fonctionne encore (vu sur DashboardOverviewOwned). Son argument
    // seasonId est non-nullable côté serveur, d'où "$seasonId: Int!" ci-dessous.
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
  // Renvoie { added, items } plutôt qu'un simple compteur depuis la v10.0 : `items` (les
  // nœuds réellement NEUFS de cet appel) sert au pont automatique (voir pushToBackend()) pour
  // n'envoyer que le delta plutôt que de renvoyer tout l'historique accumulé à chaque capture.
  function mergeGameNodes(nodes, seasonId) {
    if (!Array.isArray(nodes)) return { added: 0, items: [] };
    let added = 0;
    const items = [];
    nodes.forEach((n) => {
      if (n && n.id != null) {
        if (!games[n.id]) { added++; items.push(n); }
        // La partie elle-même ne renvoie pas son seasonId dans la réponse de l'API — on
        // l'attache nous-mêmes à partir de la variable de la requête (voir tryFireEnriched).
        // Ça permet à la visionneuse de filtrer/regrouper l'historique par saison.
        if (seasonId != null) n.seasonId = seasonId;
        games[n.id] = n;
      }
    });
    if (added > 0) saveJSON(GAMES_KEY, games);
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

  // ---------- player stats (profil personnel uniquement — les profils publics n'existent plus sur EVA) ----------
  function extractPlayerStats(payload) {
    try {
      const list = Array.isArray(payload) ? payload : [payload];
      let all = [];
      list.forEach((item) => {
        const d = item && item.data ? item.data : null;
        // On exige la présence d'un bloc de stats ("battleArenaStatistics" désormais —
        // "statistics" n'existe plus, voir note v9.3 — gardé en fallback si jamais une
        // capture plus ancienne/manuelle le renvoie encore) : d'autres requêtes du site
        // (ex: getPlayerExperience) utilisent aussi getPlayerByUserId mais sans stats
        // complètes — on ne veut pas les capturer comme un "profil".
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
    // Le seasonId fait partie de l'empreinte : au tout début d'une nouvelle saison, les
    // stats peuvent momentanément ressembler à une capture déjà vue (ex: 0 partie partout),
    // sans le seasonId dans la signature ce serait pris à tort pour un doublon et ignoré.
    const sig = seasonId + '|' + JSON.stringify(snapshot.statistics) + JSON.stringify(snapshot.battleArenaStatistics) + JSON.stringify(snapshot.experience);
    // On compare à TOUTES les captures déjà stockées, pas juste la dernière — la page de
    // profil EVA alterne entre plusieurs variantes de requête (saison en cours / toutes
    // saisons confondues) qui reviennent en boucle très rapidement, et une comparaison
    // "à la dernière seulement" laisse passer ce cas A-B-A-B-A-B sans jamais rien filtrer.
    const alreadyExists = list.some((s) => ((s.seasonId != null ? s.seasonId : null) + '|' + JSON.stringify(s.statistics) + JSON.stringify(s.battleArenaStatistics) + JSON.stringify(s.experience)) === sig);
    if (alreadyExists) return null;
    list.push(snapshot);
    list.sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    saveJSON(STATS_KEY, stats);
    // Renvoie le snapshot lui-même (pas juste `true`) depuis la v10.0 : sert au pont
    // automatique (pushToBackend()) pour n'envoyer que ce qui vient d'être réellement ajouté.
    return snapshot;
  }

  // ---------- dispatch ----------
  function handleText(text, meta) {
    if (!text) return;
    meta = meta || { allowStats: true, seasonId: null };
    const hasGames = text.indexOf(MARKER_GAMES) !== -1;
    // "statistics" n'existe plus dans le schéma (voir note v9.3 plus haut) : une réponse
    // qui le redemande encore se prend un 400 (corps `{"errors":[...]}`, sans le marqueur
    // "getPlayerByUserId") et ne matche donc de toute façon aucun des deux littéraux — ce
    // n'est pas ce test-ci qui doit filtrer ce cas, gardé seulement en fallback pour une
    // capture manuelle/ancienne qui renverrait encore l'ancien format.
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
    let addedGames = 0, addedStats = 0;
    let newGameItems = [], newStatItems = [];
    if (hasGames) {
      const nodes = extractGameNodes(json);
      if (nodes) {
        const result = mergeGameNodes(nodes, meta.seasonId);
        addedGames = result.added;
        newGameItems = result.items;
      }
    }
    if (hasStats) {
      const players = extractPlayerStats(json);
      if (players) {
        players.forEach((p) => {
          const snapshot = mergePlayerStat(p, meta.seasonId);
          if (snapshot) { addedStats++; newStatItems.push(snapshot); }
        });
      }
    }
    if (addedGames || addedStats) {
      updatePanel();
      const parts = [];
      if (addedGames) parts.push(`+${addedGames} partie(s)`);
      if (addedStats) parts.push(`+${addedStats} profil(s)`);
      flashPanel(parts.join(' · '));
      // Pont automatique (voir "PONT AUTOMATIQUE" en tête de fichier) : n'envoie que ce qui
      // vient d'être ajouté DANS CET APPEL, jamais tout l'historique accumulé — no-op silencieux
      // si le pont n'est pas configuré (voir pushToBackend()).
      pushToBackend({ nodes: newGameItems, playerStats: newStatItems });
    }
  }

  // On ne modifie plus JAMAIS la requête du site en place (voir explication plus haut) —
  // à la place, on la laisse partir intacte, et on déclenche EN PLUS un appel séparé,
  // avec les mêmes URL/méthode/headers (donc la même authentification) mais notre requête
  // enrichie. Ce deuxième appel ne repasse jamais par le code du site : le site ne voit
  // jamais sa réponse et ne peut donc jamais boucler dessus.
  const lastEnrichedAt = {}; // "operationName|variables" -> timestamp (ms) du dernier appel enrichi
  const ENRICH_THROTTLE_MS = 5000; // au moins 5 secondes entre deux appels enrichis identiques

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

    // Le throttle sert à absorber les re-déclenchements répétés d'UNE MÊME requête (ex: la
    // page de profil qui se rafraîchit en boucle avec les mêmes variables) — la clé DOIT donc
    // inclure les variables, pas juste operationName. HistoryBa est rappelée une fois par page
    // d'historique avec un "cursor" différent à chaque fois ; avec une clé basée sur le seul
    // nom d'opération, deux pages tirées à moins de 5s d'intervalle (défilement rapide) se
    // annulaient l'une l'autre et la seconde page n'était alors JAMAIS capturée — ni en
    // version enrichie ni en version réduite, puisque la réponse d'origine du site n'est
    // jamais lue (voir plus haut). C'est la cause la plus probable de parties manquantes.
    const throttleKey = opName + '|' + JSON.stringify(parsed.variables || {});
    const now = Date.now();
    if (lastEnrichedAt[throttleKey] && (now - lastEnrichedAt[throttleKey]) < ENRICH_THROTTLE_MS) return;
    lastEnrichedAt[throttleKey] = now;

    const enrichedBody = Object.assign({}, parsed, { query: QUERY_REPLACEMENTS[opName] });
    const enrichedInit = Object.assign({}, init, { body: JSON.stringify(enrichedBody) });

    // Ni les parties ni les captures de profil ne renvoient leur propre seasonId dans la
    // réponse — on récupère donc le seasonId directement depuis les VARIABLES de la
    // requête envoyée (le site le connaît forcément, puisque c'est lui qui filtre par
    // saison) et on l'attache nous-mêmes à ce qu'on stocke. Pour HistoryBa, le site exige
    // toujours un seasonId précis (il n'affiche que les parties de la saison sélectionnée),
    // donc cette valeur est fiable à chaque appel.
    const requestSeasonId = parsed.variables && parsed.variables.seasonId != null ? parsed.variables.seasonId : null;

    origFetch.call(pageWindow, url, enrichedInit)
      .then((res) => res.text())
      .then((text) => {
        const allowStats = opName !== 'UseProfileUserOwned' || requestSeasonId != null;
        handleText(text, { allowStats, seasonId: requestSeasonId });
      })
      .catch(() => { /* échec ponctuel, sans conséquence : on retentera à la prochaine requête du site */ });
  }

  // ---------- interception fetch() : ne touche jamais à la requête du site, en déclenche une deuxième à côté ----------
  // pageWindow, PAS window (voir l'avertissement plus haut) : c'est bien le fetch que LE SITE
  // appelle qu'on doit remplacer, pas celui d'un contexte sandboxé que lui seul verrait.
  const origFetch = pageWindow.fetch;
  pageWindow.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (url) tryFireEnriched(url, init);
    } catch (e) { /* si le déclenchement échoue, la requête du site part quand même normalement */ }
    return origFetch.call(this, input, init);
  };

  // ---------- interception XMLHttpRequest : capture passive uniquement (EVA n'utilise que fetch()
  // en pratique, ceci est un filet de sécurité qui ne modifie jamais rien) ----------
  const origSend = pageWindow.XMLHttpRequest.prototype.send;
  pageWindow.XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', function () {
      try { handleText(this.responseText, { allowStats: true, seasonId: null }); } catch (e) {}
    });
    return origSend.call(this, body);
  };

  // ---------- pont automatique vers EVA-Debrief (v10.0) ----------
  // Config dans le magasin GM_getValue/GM_setValue (PAS localStorage, comme games/stats) :
  // GM_* est isolé par script plutôt que par domaine, donc ce réglage (fait une fois sur EVA)
  // reste valable même si le script tourne aussi sur d'autres pages (voir HOST_HINT) ou si le
  // domaine EVA change légèrement — et ça évite tout risque de collision avec une clé du site
  // lui-même dans son propre localStorage.
  const BRIDGE_URL_KEY = 'eva_debrief_bridge_url';
  const BRIDGE_TOKEN_KEY = 'eva_debrief_import_token';

  function getBridgeConfig() {
    return {
      url: (GM_getValue(BRIDGE_URL_KEY, '') || '').replace(/\/+$/, ''), // sans slash final
      token: GM_getValue(BRIDGE_TOKEN_KEY, '') || '',
    };
  }

  // Deux points d'entrée pour la même config : le menu Tampermonkey (GM_registerMenuCommand,
  // enregistré plus bas) ET un bouton dans le panneau — le menu est peu accessible sur certains
  // navigateurs mobiles compatibles GM_* (Firefox Android notamment), le bouton reste lui
  // toujours atteignable quel que soit le runtime.
  function configureBridge() {
    const current = getBridgeConfig();
    const url = window.prompt(
      'URL de ton instance EVA-Debrief (ex: https://eva.tondomaine.fr) — vide pour désactiver le pont :',
      current.url
    );
    if (url === null) return; // annulé
    const trimmedUrl = url.trim().replace(/\/+$/, '');
    GM_setValue(BRIDGE_URL_KEY, trimmedUrl);
    if (!trimmedUrl) {
      GM_setValue(BRIDGE_TOKEN_KEY, '');
      updateBridgeStatus();
      flashPanel('Pont automatique désactivé');
      return;
    }
    const token = window.prompt(
      'Jeton d\'import (onglet "+ Importer" de ton EVA-Debrief, section "Pont automatique") :',
      current.token
    );
    if (token === null) return; // annulé
    GM_setValue(BRIDGE_TOKEN_KEY, token.trim());
    updateBridgeStatus();
    flashPanel('Pont automatique configuré');
  }

  // N'envoie que si le pont est configuré (opt-in strict) et qu'il y a réellement du delta à
  // envoyer. GM_xmlhttpRequest contourne CORS nativement (contrairement à fetch() en contexte
  // page) et n'envoie jamais les cookies du site EVA — seul le jeton d'import, dans son propre
  // en-tête, authentifie la requête auprès d'EVA-Debrief. Ne lève jamais d'exception : un échec
  // (jeton révoqué, backend injoignable, délai dépassé...) ne doit jamais interrompre la
  // capture locale, qui reste de toute façon disponible via "Télécharger JSON".
  function pushToBackend({ nodes, playerStats }) {
    const { url, token } = getBridgeConfig();
    if (!url || !token) return; // pont non configuré : no-op silencieux
    if (!nodes.length && !playerStats.length) return;
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: url + '/api/import',
        headers: { 'Content-Type': 'application/json', 'X-Import-Token': token },
        data: JSON.stringify({ nodes, playerStats }),
        timeout: 15000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            console.warn('[EVA Collector] Échec du push vers EVA-Debrief, HTTP', res.status, res.responseText);
            flashPanel(`⚠️ Échec de l'envoi à EVA-Debrief (HTTP ${res.status})`);
            return;
          }
          // Un HTTP 200 ne veut pas dire que quelque chose a été AJOUTÉ (dédup, parties PvE
          // filtrées, données invalides...) — /api/import renvoie toujours le détail exact
          // (mêmes champs que l'écran d'import manuel d'EVA-Debrief), on l'affiche donc en
          // toutes lettres plutôt qu'un simple "envoyé" trompeur qui masquerait un problème
          // réel (ex: mauvais token pointant vers le mauvais compte, mauvaise URL de backend).
          let body = {};
          try { body = JSON.parse(res.responseText); } catch (e) { /* réponse non-JSON, tant pis */ }
          const added = (body.addedGames || 0) + (body.addedStats || 0);
          if (added > 0) {
            flashPanel(`🔗 Envoyé (+${body.addedGames || 0} partie(s), +${body.addedStats || 0} profil(s))`);
          } else {
            flashPanel('🔗 Envoyé, mais 0 ajouté (déjà connu ou filtré — voir console)');
            console.warn('[EVA Collector] Push accepté par EVA-Debrief mais rien de nouveau ajouté :', body);
          }
        },
        onerror: () => { console.warn('[EVA Collector] Échec du push vers EVA-Debrief (réseau).'); flashPanel('⚠️ Échec de l\'envoi à EVA-Debrief (réseau)'); },
        ontimeout: () => { console.warn('[EVA Collector] Push vers EVA-Debrief : délai dépassé.'); flashPanel('⚠️ Envoi à EVA-Debrief : délai dépassé'); },
      });
    } catch (e) {
      console.warn('[EVA Collector] Échec du push vers EVA-Debrief :', e.message);
    }
  }

  // Renvoie TOUT ce qui est stocké localement (pas juste le delta d'une capture) — utile pour
  // deux cas que le push automatique (delta-only, voir pushToBackend) ne couvre pas : (1) des
  // données déjà capturées AVANT d'avoir configuré le pont ne sont sinon jamais envoyées
  // automatiquement (le delta ne regarde que ce qui vient d'être ajouté À CET INSTANT) ; (2)
  // retenter un envoi après un échec, sans avoir à revisiter les pages EVA (revisiter ne
  // redéclencherait rien de "neuf" pour des parties déjà connues localement).
  function resendAll() {
    const { url, token } = getBridgeConfig();
    if (!url || !token) {
      flashPanel('Configure d\'abord le pont ("⚙️ Configurer")');
      return;
    }
    const nodes = Object.values(games);
    const playerStats = [];
    Object.values(stats).forEach((arr) => playerStats.push(...arr));
    if (!nodes.length && !playerStats.length) {
      flashPanel('Rien à envoyer (aucune capture locale)');
      return;
    }
    flashPanel('Envoi en cours…');
    pushToBackend({ nodes, playerStats });
  }

  function updateBridgeStatus() {
    if (!bridgeStatusEl) return;
    const { url, token } = getBridgeConfig();
    bridgeStatusEl.textContent = (url && token) ? '🔗 Pont : connecté' : '⚪ Pont : non configuré';
  }

  // Enregistré au chargement du script (synchrone, pas dans un callback DOMContentLoaded — les
  // menu commands Tampermonkey doivent s'enregistrer immédiatement) : disponible dès que le
  // script est actif sur le site EVA, sans attendre le panneau.
  GM_registerMenuCommand('Configurer EVA-Debrief', configureBridge);

  // ---------- panneau flottant ----------
  // Réductible et déplaçable : utile pour le laisser en place mais hors du chemin quand on
  // navigue ailleurs sur le site (le script tourne sur tout le domaine, pas juste
  // historique/profil — voir HOST_HINT plus haut). L'état réduit/déplié, la position glissée
  // et l'état fermé sont mémorisés dans localStorage (même clé que games/stats, donc partagés
  // entre onglets et persistants d'un rechargement à l'autre) pour ne pas avoir à tout
  // reconfigurer à chaque nouvelle page.
  let panel, reopenBtn, gamesCountEl, statsCountEl, statusEl, bodyEl, badgeEl, toggleBtn, headerEl, bridgeStatusEl;
  let minimized = loadJSON(MINIMIZED_KEY, false);
  let closed = loadJSON(CLOSED_KEY, false);
  let position = loadJSON(POSITION_KEY, null); // {left, top} en px, null = position par défaut (bas-droite)

  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = `
      position:fixed; bottom:16px; right:16px; z-index:2147483647;
      background:#11151f; color:#e7ebf3; font-family:-apple-system,Segoe UI,Roboto,sans-serif;
      font-size:13px; border:1px solid #2b3348; border-radius:10px;
      box-shadow:0 6px 24px rgba(0,0,0,.45); user-select:none;
    `;
    panel.innerHTML = `
      <div id="eva-collector-header" title="Glisser pour déplacer" style="font-weight:700;padding:12px 14px;display:flex;align-items:center;gap:6px;cursor:grab;">
        <span>🎮</span><span style="flex:1;">EVA Collector</span>
        <span id="eva-collector-badge" style="display:none;color:#8892a6;font-weight:400;font-size:11px;white-space:nowrap;"></span>
        <button id="eva-collector-toggle" title="Réduire" style="background:none;border:none;color:#8892a6;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;">–</button>
        <button id="eva-collector-close" title="Fermer" style="background:none;border:none;color:#8892a6;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;">✕</button>
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
        <div id="eva-collector-bridge-status" style="font-size:11px;color:#8892a6;margin-bottom:8px;"></div>
        <button id="eva-collector-download" style="width:100%;margin-bottom:6px;padding:7px;border:none;border-radius:6px;background:#4f9dff;color:#0a0d14;font-weight:700;cursor:pointer;">Télécharger JSON</button>
        <button id="eva-collector-copy" style="width:100%;margin-bottom:6px;padding:7px;border:none;border-radius:6px;background:#232a3a;color:#e7ebf3;cursor:pointer;">Copier le JSON</button>
        <button id="eva-collector-configure" style="width:100%;margin-bottom:6px;padding:7px;border:none;border-radius:6px;background:#232a3a;color:#e7ebf3;cursor:pointer;">⚙️ Configurer EVA-Debrief</button>
        <button id="eva-collector-resend" style="width:100%;margin-bottom:6px;padding:7px;border:none;border-radius:6px;background:#232a3a;color:#e7ebf3;cursor:pointer;">🔄 Renvoyer tout à EVA-Debrief</button>
        <button id="eva-collector-clear" style="width:100%;padding:7px;border:none;border-radius:6px;background:#3a1c22;color:#ff9aa2;cursor:pointer;">Tout vider</button>
      </div>
    `;
    document.documentElement.appendChild(panel);
    gamesCountEl = panel.querySelector('#eva-collector-games');
    statsCountEl = panel.querySelector('#eva-collector-stats');
    statusEl = panel.querySelector('#eva-collector-status');
    bridgeStatusEl = panel.querySelector('#eva-collector-bridge-status');
    bodyEl = panel.querySelector('#eva-collector-body');
    badgeEl = panel.querySelector('#eva-collector-badge');
    toggleBtn = panel.querySelector('#eva-collector-toggle');
    headerEl = panel.querySelector('#eva-collector-header');

    if (position) applyPosition(position);

    panel.querySelector('#eva-collector-download').addEventListener('click', downloadJSON);
    panel.querySelector('#eva-collector-copy').addEventListener('click', copyJSON);
    // Même fonction que le menu Tampermonkey (GM_registerMenuCommand plus haut) — ce bouton
    // reste accessible même sur les runtimes mobiles où ce menu est peu pratique à atteindre.
    panel.querySelector('#eva-collector-configure').addEventListener('click', configureBridge);
    panel.querySelector('#eva-collector-resend').addEventListener('click', resendAll);
    panel.querySelector('#eva-collector-clear').addEventListener('click', () => {
      games = {}; stats = {};
      saveJSON(GAMES_KEY, games);
      saveJSON(STATS_KEY, stats);
      updatePanel();
      flashPanel('Tout a été vidé');
    });
    // Fermer ne doit pas aussi basculer l'état réduit du header sous-jacent.
    panel.querySelector('#eva-collector-close').addEventListener('click', (e) => {
      e.stopPropagation();
      setClosed(true);
    });
    // Le header entier bascule l'état réduit (pas juste le petit bouton — plus facile à
    // cliquer), sauf si le clic vient de terminer un glissé (voir wireDrag) ou d'un bouton
    // qui gère déjà son propre clic (toggle bascule aussi via ce même listener par bubbling,
    // fermer stoppe sa propagation ci-dessus).
    headerEl.addEventListener('click', () => {
      if (headerEl._justDragged) { headerEl._justDragged = false; return; }
      setMinimized(!minimized);
    });
    wireDrag();

    buildReopenBtn();
    applyMinimizedState();
    applyClosedState();
    updatePanel();
    updateBridgeStatus();
  }

  function buildReopenBtn() {
    reopenBtn = document.createElement('button');
    reopenBtn.textContent = '🎮';
    reopenBtn.title = 'Ouvrir EVA Collector';
    reopenBtn.style.cssText = `
      position:fixed; bottom:16px; right:16px; z-index:2147483647;
      width:40px; height:40px; border-radius:50%; border:1px solid #2b3348;
      background:#11151f; color:#e7ebf3; font-size:18px; cursor:pointer;
      box-shadow:0 6px 24px rgba(0,0,0,.45); display:none; align-items:center; justify-content:center; padding:0;
    `;
    reopenBtn.addEventListener('click', () => setClosed(false));
    document.documentElement.appendChild(reopenBtn);
  }

  // Glisser-déposer du panneau par son header. On bascule d'un positionnement bottom/right
  // à left/top au premier déplacement (sinon le panneau "grandirait" depuis le coin fixe au
  // lieu de suivre la souris), et on retient la position en pixels absolus pour la restaurer
  // au prochain chargement de page.
  function wireDrag() {
    let drag = null;
    headerEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return; // laisser les boutons gérer leur propre clic
      const rect = panel.getBoundingClientRect();
      drag = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top, moved: false };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      drag.moved = true;
      headerEl.style.cursor = 'grabbing';
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
      const left = Math.min(Math.max(0, drag.startLeft + dx), maxLeft);
      const top = Math.min(Math.max(0, drag.startTop + dy), maxTop);
      applyPosition({ left, top });
    });
    document.addEventListener('mouseup', () => {
      if (!drag) return;
      headerEl.style.cursor = 'grab';
      if (drag.moved) {
        const rect = panel.getBoundingClientRect();
        position = { left: rect.left, top: rect.top };
        saveJSON(POSITION_KEY, position);
        headerEl._justDragged = true;
      }
      drag = null;
    });
  }

  function applyPosition(pos) {
    panel.style.left = pos.left + 'px';
    panel.style.top = pos.top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
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

  function setClosed(value) {
    closed = value;
    saveJSON(CLOSED_KEY, closed);
    applyClosedState();
  }

  function applyClosedState() {
    if (!panel || !reopenBtn) return;
    panel.style.display = closed ? 'none' : 'block';
    reopenBtn.style.display = closed ? 'flex' : 'none';
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
