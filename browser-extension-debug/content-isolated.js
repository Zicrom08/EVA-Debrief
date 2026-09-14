// ============================================================================
// EVA-Debrief — Collecteur (DEBUG)
// content-isolated.js — identique à browser-extension/content-isolated.js dans sa
// logique, avec un log à chaque relais (capture -> service worker, ping/pong,
// poignée de main de liaison) pour confirmer que CE maillon de la chaîne fonctionne.
// ============================================================================

(function () {
  'use strict';

  const LOG = '[EVA-Debrief DEBUG]';
  const HOST_HINT = 'eva';
  const isEvaSite = location.hostname.toLowerCase().includes(HOST_HINT);
  console.info(LOG, 'content-isolated.js actif sur', location.hostname, '— site EVA détecté ?', isEvaSite);

  if (isEvaSite) {
    document.addEventListener('eva-debrief-capture', (e) => {
      console.info(LOG, 'CustomEvent eva-debrief-capture reçu depuis content-main-world.js —', (e.detail.nodes || []).length, 'partie(s),', (e.detail.playerStats || []).length, 'profil(s). Relais vers le service worker (chrome.runtime.sendMessage).');
      chrome.runtime.sendMessage({ type: 'EVA_CAPTURE', ...e.detail }, (result) => {
        if (chrome.runtime.lastError) {
          console.error(LOG, 'chrome.runtime.sendMessage a échoué :', chrome.runtime.lastError.message, '— le service worker est peut-être inactif/rechargé.');
        } else {
          console.info(LOG, 'Message EVA_CAPTURE délivré au service worker (pas de réponse attendue pour ce type).');
        }
      });
    });
    return;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;

    if (e.data.type === 'EVA_DEBRIEF_PING') {
      console.info(LOG, 'EVA_DEBRIEF_PING reçu depuis la page, réponse PONG envoyée.');
      window.postMessage({ type: 'EVA_DEBRIEF_PONG' }, e.origin);
      return;
    }

    if (e.data.type === 'EVA_DEBRIEF_LINK_REQUEST') {
      console.info(LOG, 'EVA_DEBRIEF_LINK_REQUEST reçu :', { backendUrl: e.data.backendUrl, hasToken: !!e.data.importToken });
      const { backendUrl, importToken } = e.data;
      chrome.runtime.sendMessage({ type: 'LINK_REQUEST', backendUrl, importToken }, (result) => {
        console.info(LOG, 'Réponse du service worker à LINK_REQUEST :', result, chrome.runtime.lastError ? `(erreur: ${chrome.runtime.lastError.message})` : '');
        window.postMessage({
          type: 'EVA_DEBRIEF_LINK_RESULT',
          ok: !!(result && result.ok),
          error: result && result.error,
        }, e.origin);
      });
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'EVA_DEBRIEF_TRIGGER_LINK') return false;
    console.info(LOG, 'EVA_DEBRIEF_TRIGGER_LINK reçu depuis le popup, relais vers la page.');
    const origin = window.location.origin;
    const timeoutId = setTimeout(() => {
      console.warn(LOG, 'EVA_DEBRIEF_TRIGGER_LINK : timeout de 3s, aucune réponse de la page.');
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
    return true;
  });
})();
