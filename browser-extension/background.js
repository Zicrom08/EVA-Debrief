// ============================================================================
// EVA-Debrief — Collecteur automatique (extension)
// background.js — service worker : configuration (chrome.storage.local) + push
// réel vers /api/import.
//
// Le push se fait ICI, jamais depuis un content script : depuis un changement
// Chromium de 2021, un fetch() lancé par un content script est soumis au CORS
// normal de la PAGE, alors qu'un fetch() lancé depuis un contexte d'extension pur
// (service worker, popup...) est exempté de CORS pour toute origine couverte par
// host_permissions (voir manifest.json, <all_urls> — nécessaire puisque le backend
// de chaque utilisateur vit à une origine choisie par lui, inconnue à l'avance).
// C'est l'équivalent exact de GM_xmlhttpRequest côté userscript : même raison,
// même contournement, juste un mécanisme différent.
// ============================================================================

const CONFIG_KEYS = ['backendUrl', 'importToken'];

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(CONFIG_KEYS, (data) => {
      resolve({ backendUrl: data.backendUrl || '', importToken: data.importToken || '' });
    });
  });
}

// Valide grossièrement que backendUrl ressemble à une URL http(s) avant de la
// stocker — pas une validation exhaustive, juste de quoi éviter un enregistrement
// manifestement cassé (ex: collé par erreur l'URL d'une autre page).
function isPlausibleUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function handleLinkRequest(message, sendResponse) {
  const backendUrl = String(message.backendUrl || '').trim().replace(/\/+$/, ''); // sans slash final
  const importToken = String(message.importToken || '').trim();
  if (!isPlausibleUrl(backendUrl) || !importToken) {
    sendResponse({ ok: false, error: 'URL ou jeton invalide.' });
    return;
  }
  chrome.storage.local.set({ backendUrl, importToken }, () => {
    sendResponse({ ok: true });
  });
}

// Un HTTP 200 ne veut pas dire que quelque chose a été AJOUTÉ (dédup, parties PvE
// filtrées, données invalides, mauvais jeton pointant vers le mauvais compte...) —
// /api/import renvoie toujours le détail exact (mêmes champs que l'écran d'import
// manuel d'EVA-Debrief) : on le garde en mémoire plutôt que de se fier au seul code
// HTTP — c'est exactement la leçon apprise en mettant au point le pont userscript.
function setLastPushStatus(status) {
  chrome.storage.local.set({ lastPushStatus: { ...status, at: new Date().toISOString() } });
}

async function handleCapture({ nodes, playerStats }) {
  const { backendUrl, importToken } = await getConfig();
  if (!backendUrl || !importToken) return; // pont non lié : no-op silencieux, strictement opt-in
  if (!(nodes && nodes.length) && !(playerStats && playerStats.length)) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(backendUrl + '/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Import-Token': importToken },
      body: JSON.stringify({ nodes, playerStats }),
      signal: controller.signal,
    });
    let body = {};
    try { body = await res.json(); } catch (e) { /* réponse non-JSON, tant pis */ }
    if (!res.ok) {
      console.warn('[EVA-Debrief] Échec du push, HTTP', res.status, body);
      setLastPushStatus({ ok: false, httpStatus: res.status });
      return;
    }
    const added = (body.addedGames || 0) + (body.addedStats || 0);
    if (added === 0) {
      console.warn('[EVA-Debrief] Push accepté mais rien de nouveau ajouté :', body);
    }
    setLastPushStatus({ ok: true, addedGames: body.addedGames || 0, addedStats: body.addedStats || 0 });
  } catch (e) {
    console.warn('[EVA-Debrief] Échec du push (réseau/délai dépassé) :', e.message);
    setLastPushStatus({ ok: false, error: e.message });
  } finally {
    clearTimeout(timeoutId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'LINK_REQUEST') {
    handleLinkRequest(message, sendResponse);
    return true; // réponse asynchrone (chrome.storage.local.set callback)
  }
  if (message.type === 'EVA_CAPTURE') {
    handleCapture(message);
    return false; // pas de réponse attendue par content-isolated.js pour ce type
  }
  return false;
});
