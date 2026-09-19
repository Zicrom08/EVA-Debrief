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

  // ---------- popup de secours (notifications système bloquées, voir background.js) ----------
  // Un seul encart réutilisé (jamais empilé) : une capture "en cours" mise à jour en "terminé"
  // remplace le même encart plutôt que d'en laisser deux à l'écran. Shadow DOM (mode "closed")
  // pour ne jamais hériter ni polluer le CSS du site EVA — cet encart doit rester identique
  // quelle que soit la page. Construit avec des noeuds texte (jamais innerHTML sur le titre/
  // message, qui viennent de notre propre extension mais autant garder le réflexe).
  let toastHost = null, toastShadow = null, toastHideTimer = null;

  function ensureToastHost() {
    if (toastHost && toastHost.isConnected) return toastShadow;
    toastHost = document.createElement('div');
    toastHost.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
    (document.documentElement || document.body).appendChild(toastHost);
    toastShadow = toastHost.attachShadow({ mode: 'closed' });
    return toastShadow;
  }

  function showToast({ kind, title, message, sticky }) {
    const shadow = ensureToastHost();
    shadow.innerHTML = '';
    const accent = kind === 'success' ? '#4caf7d' : kind === 'error' ? '#e0575b' : '#5b8def';
    const box = document.createElement('div');
    box.style.cssText = `font-family:system-ui,-apple-system,sans-serif;background:#1e1e24;
      color:#e8e8ec;border-left:4px solid ${accent};border-radius:6px;padding:10px 14px;
      min-width:220px;max-width:320px;box-shadow:0 4px 16px rgba(0,0,0,.4);
      font-size:13px;line-height:1.4;`;
    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight:600;margin-bottom:2px;';
    titleEl.textContent = title;
    const msgEl = document.createElement('div');
    msgEl.style.cssText = 'color:#b7b7c2;';
    msgEl.textContent = message;
    box.appendChild(titleEl);
    box.appendChild(msgEl);
    shadow.appendChild(box);
    clearTimeout(toastHideTimer);
    if (!sticky) {
      toastHideTimer = setTimeout(() => {
        if (toastHost) { toastHost.remove(); toastHost = null; toastShadow = null; }
      }, 5000);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'EVA_DEBRIEF_TOAST') showToast(message);
    return false; // pas de réponse attendue, voir sendToast() dans background.js
  });

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
