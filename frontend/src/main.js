// ============================================================================
// EVA Debrief : frontend (SPA, aucun framework — modules ES chargés par Vite)
//
// Ce fichier est le point d'entrée : il importe tous les modules (état partagé,
// API, filtres, import, chaque onglet, coquille de l'app) puis lance le
// chargement des données au démarrage. Il ne stocke rien lui-même — toutes les
// données (parties, profils de saison, équipes) vivent sur le serveur
// (voir backend/server.js / backend/db.js) et sont chargées via l'API HTTP
// (/api/...). Seules quelques préférences d'affichage sans enjeu (joueur
// sélectionné, filtres actifs) sont gardées dans le localStorage du
// navigateur, via persistUiPrefs()/restoreUiPrefs() (voir ui-prefs.js).
//
// Modèle de données en mémoire, voir state.js (rechargé intégralement depuis
// le serveur à chaque import, voir loadFromServer() dans api.js).
//
// Carte des modules :
//   state.js         état mutable partagé
//   format.js        formatage (dates/durées/nombres) + petits helpers purs
//   api.js           appels réseau vers le backend (apiGet/apiSend/loadFromServer)
//   ui-prefs.js      préférences d'affichage en localStorage
//   game-filters.js  prédicats de filtrage (période, cartes/modes exclus)
//   historique.js, tendances.js, comparatif.js, equipes.js, profil/*
//                    un module par onglet (fonctions compute*/render*/build*)
//   player-index.js  index des joueurs connus + sélecteur "Joueur" du header
//   shell.js         coquille de l'app (résumé, boutons du header)
//   tabs.js          bascule entre onglets
//   filters-ui.js    barre de filtres (période, exclusion cartes/modes)
//   import.js        écran d'import (glisser-déposer, coller du JSON)
// ============================================================================

import { state } from './state.js';
import { restoreUiPrefs, persistUiPrefs } from './ui-prefs.js';
import { loadFromServer, getMe } from './api.js';
import { ensureModeDefaults } from './game-filters.js';
import { rebuildPlayerIndex } from './player-index.js';
import { showApp } from './shell.js';
import './tabs.js';
import './filters-ui.js';
import './import.js';

// ================= DÉMARRAGE : chargement des données depuis le serveur =================
(async function init() {
  restoreUiPrefs(); // petites préférences d'affichage (joueur sélectionné, filtres...), sans enjeu
  try {
    await loadFromServer();
    state.currentUser = await getMe();
  } catch (e) {
    if (e.message === 'session expirée') return; // redirection vers /login.html déjà déclenchée
    const help = document.querySelector('.import-help');
    if (help) {
      help.innerHTML += `<br><br><strong style="color:var(--loss);">Impossible de contacter le serveur</strong> (${e.message}).
        Vérifie que le serveur tourne bien (<code>node backend/server.js</code>) et que cette page est servie par lui
        (via son adresse http://..., pas ouverte en double-cliquant sur le fichier).`;
    }
    return;
  }
  if (Object.keys(state.gamesById).length > 0 || Object.keys(state.playerStatsSnapshots).length > 0) {
    ensureModeDefaults();
    rebuildPlayerIndex();
    persistUiPrefs();
    showApp();
  }
})();
