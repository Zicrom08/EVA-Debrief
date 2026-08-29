// ============================================================================
// EVA-Debrief — Collecteur automatique (extension)
// content-isolated.js — pont entre la page et le service worker.
//
// Tourne dans le monde ISOLATED par défaut (contrairement à content-main-world.js) :
// garde donc l'accès à chrome.runtime, contrairement à ce dernier. Deux
// responsabilités bien séparées, distinguées par HOST_HINT (même test que le
// userscript et que content-main-world.js) :
//
// 1. Sur le site EVA : relaie les captures de content-main-world.js (reçues via un
//    CustomEvent sur `document`, seul pont possible entre les deux mondes d'une même
//    page) vers le service worker, qui gère la config et le push réel.
// 2. Sur n'importe quelle AUTRE page (potentiellement une instance EVA-Debrief,
//    dont l'origine n'est jamais connue à l'avance — voir manifest.json,
//    host_permissions/content_scripts en <all_urls>) : écoute une poignée de main
//    postMessage pour lier l'extension au compte EVA-Debrief de l'utilisateur, sans
//    jamais avoir à copier-coller une URL ou un jeton à la main.
// ============================================================================

(function () {
  'use strict';

  const HOST_HINT = 'eva';
  const isEvaSite = location.hostname.toLowerCase().includes(HOST_HINT);

  if (isEvaSite) {
    // ---------- capture -> service worker ----------
    document.addEventListener('eva-debrief-capture', (e) => {
      chrome.runtime.sendMessage({ type: 'EVA_CAPTURE', ...e.detail });
    });
    return; // pas de poignée de main de liaison sur le site EVA lui-même.
  }

  // ---------- poignée de main de liaison (n'importe quelle autre page) ----------
  // Validation stricte : `e.source === window` exclut tout message venant d'une
  // iframe ou d'un autre contexte que CETTE page elle-même ; `e.data.type` inconnu
  // est ignoré silencieusement (une page peut légitimement faire circuler plein
  // d'autres postMessage sans rapport, pas la peine d'en faire du bruit).
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;

    if (e.data.type === 'EVA_DEBRIEF_PING') {
      // Sert à la page EVA-Debrief pour savoir si l'extension est installée avant
      // d'afficher son bouton de liaison bien en évidence. Jamais '*' en
      // targetOrigin : toujours l'origine exacte reçue.
      window.postMessage({ type: 'EVA_DEBRIEF_PONG' }, e.origin);
      return;
    }

    if (e.data.type === 'EVA_DEBRIEF_LINK_REQUEST') {
      const { backendUrl, importToken } = e.data;
      chrome.runtime.sendMessage({ type: 'LINK_REQUEST', backendUrl, importToken }, (result) => {
        window.postMessage({
          type: 'EVA_DEBRIEF_LINK_RESULT',
          ok: !!(result && result.ok),
          error: result && result.error,
        }, e.origin);
      });
    }
  });

  // Déclenché par le popup de l'extension (bouton "Lier ce compte" dans popup.js), quand
  // l'utilisateur clique alors que l'onglet actif est potentiellement une instance
  // EVA-Debrief : relaie la demande à la page elle-même, qui gère tout le flux (jeton
  // existant ou généré, poignée de main EVA_DEBRIEF_LINK_REQUEST ci-dessus) exactement comme
  // si le bouton "Lier l'extension EVA-Debrief" avait été cliqué sur la page — un seul chemin
  // de liaison, déclenchable depuis deux endroits différents.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'EVA_DEBRIEF_TRIGGER_LINK') return false;
    const origin = window.location.origin;
    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', handler);
      sendResponse(null);
    }, 3000);
    function handler(e) {
      if (e.source !== window || e.origin !== origin) return;
      if (!e.data || e.data.type !== 'EVA_DEBRIEF_TRIGGER_LINK_RESULT') return;
      clearTimeout(timeoutId);
      window.removeEventListener('message', handler);
      sendResponse(e.data);
    }
    window.addEventListener('message', handler);
    window.postMessage({ type: 'EVA_DEBRIEF_TRIGGER_LINK' }, origin);
    return true; // réponse asynchrone (round-trip avec la page)
  });
})();
