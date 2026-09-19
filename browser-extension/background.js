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

// Notification navigateur distincte pour chaque type d'import terminé (profil / parties) —
// demandé explicitement pour que l'utilisateur soit informé sans avoir à ouvrir le popup de
// l'extension pour le savoir. Une seule par type, déclenchée uniquement quand quelque chose a
// vraiment été ajouté (jamais à chaque capture, voir l'appel dans handleCapture ci-dessous, qui
// se base sur addedGames/addedStats renvoyés par le serveur — pas sur la simple présence de
// nodes/playerStats dans la requête, qui peut très bien ne rien contenir de nouveau, ex:
// re-parcourir des pages déjà capturées).
function notify(id, title, message) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
  });
}

// chrome.notifications.getPermissionLevel() ne reflète QUE la permission Chrome/site pour cette
// extension — jamais un blocage au niveau de Windows lui-même (notifications désactivées pour
// Chrome dans les paramètres système, mode Assistant de concentration...), qu'aucune extension
// ne peut détecter par API. C'est néanmoins le seul signal programmatique disponible : "denied"
// bascule sur le petit encart affiché directement dans la page (voir showToast dans
// content-isolated.js) plutôt que de compter sur une notification système qui ne partirait de
// toute façon jamais. Un blocage purement Windows (permission Chrome restée "granted" mais
// notification silencieusement avalée par l'OS) reste indétectable et continuera donc à
// utiliser les notifications système — aucun moyen ici de faire mieux.
function notificationsAllowed() {
  return new Promise((resolve) => {
    chrome.notifications.getPermissionLevel((level) => resolve(level === 'granted'));
  });
}

// Relaie vers le content script de l'onglet à l'origine de la capture (voir handleCapture) —
// jamais vers un autre onglet, jamais de fallback "tous les onglets EVA ouverts" : plus simple
// et suffisant, l'utilisateur est de toute façon sur cet onglet-là au moment de la capture.
// chrome.runtime.lastError attendu si l'onglet a été fermé/rechargé entre-temps — sans
// conséquence, juste "consommé" pour éviter le warning correspondant dans la console.
function sendToast(tabId, toast) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'EVA_DEBRIEF_TOAST', ...toast }, () => {
    void chrome.runtime.lastError;
  });
}

async function handleCapture({ nodes, playerStats }, tabId) {
  const { backendUrl, importToken } = await getConfig();
  if (!backendUrl || !importToken) return; // pont non lié : no-op silencieux, strictement opt-in
  if (!(nodes && nodes.length) && !(playerStats && playerStats.length)) return;

  // host_permissions ("<all_urls>", voir manifest.json) seul ne suffit PAS à exempter ce
  // fetch() du CORS normal du web : il faut EN PLUS que "Accès aux sites" (chrome://extensions
  // → cette extension → Détails) soit réglé sur "Sur tous les sites" — sinon Chrome applique
  // les règles CORS classiques (preflight, Access-Control-Allow-Origin) et ce fetch échoue,
  // sans qu'aucun message ne remonte nulle part dans l'UI de l'extension (seulement dans la
  // console du service worker) — piège réel rencontré en usage : diagnostiqué puis corrigé.
  // chrome.permissions.contains() vérifie le VRAI consentement runtime, pas juste ce que
  // déclare le manifest, pour donner un message actionnable plutôt qu'un TypeError générique.
  const originPattern = new URL(backendUrl).origin + '/*';
  const hasPerm = await new Promise((resolve) => chrome.permissions.contains({ origins: [originPattern] }, resolve));
  if (!hasPerm) {
    console.error('[EVA-Debrief] Permission de site non accordée pour', originPattern, '— va dans chrome://extensions → cette extension → Détails → "Accès aux sites" → "Sur tous les sites".');
    setLastPushStatus({ ok: false, permissionMissing: true, origin: originPattern });
    return;
  }

  // Notifications système bloquées (voir notificationsAllowed() ci-dessus) : tout le cycle de
  // vie de cet import (en cours -> terminé/échec) passe par le petit encart dans la page plutôt
  // que par les notifications système ci-dessous, dont on sait déjà qu'elles ne partiront pas.
  // "En cours" n'a de sens qu'en secours ici : pas l'équivalent côté notification système,
  // ça n'apporterait rien d'utile en plus des notifications ponctuelles déjà en place.
  const useToast = !(await notificationsAllowed());
  if (useToast) sendToast(tabId, { kind: 'info', title: 'EVA-Debrief', message: 'Import en cours…', sticky: true });

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
      if (useToast) sendToast(tabId, { kind: 'error', title: 'EVA-Debrief', message: `Échec de l'import (HTTP ${res.status}).` });
      return;
    }
    const added = (body.addedGames || 0) + (body.addedStats || 0);
    if (added === 0) {
      console.warn('[EVA-Debrief] Push accepté mais rien de nouveau ajouté :', body);
      if (useToast) sendToast(tabId, { kind: 'info', title: 'EVA-Debrief', message: 'Import terminé — rien de nouveau à ajouter.' });
    }
    if (body.addedGames > 0) {
      if (useToast) sendToast(tabId, { kind: 'success', title: 'EVA-Debrief', message: `Import des parties terminé : ${body.addedGames} nouvelle(s) partie(s) ajoutée(s).` });
      else notify('eva-debrief-games', 'EVA-Debrief', `Import des parties terminé : ${body.addedGames} nouvelle(s) partie(s) ajoutée(s).`);
    }
    if (body.addedStats > 0) {
      if (useToast) sendToast(tabId, { kind: 'success', title: 'EVA-Debrief', message: `Import du profil terminé : ${body.addedStats} profil(s) capturé(s) ajouté(s).` });
      else notify('eva-debrief-stats', 'EVA-Debrief', `Import du profil terminé : ${body.addedStats} profil(s) capturé(s) ajouté(s).`);
    }
    setLastPushStatus({ ok: true, addedGames: body.addedGames || 0, addedStats: body.addedStats || 0 });
  } catch (e) {
    console.warn('[EVA-Debrief] Échec du push (réseau/délai dépassé) :', e.message);
    setLastPushStatus({ ok: false, error: e.message });
    if (useToast) sendToast(tabId, { kind: 'error', title: 'EVA-Debrief', message: `Échec de l'import : ${e.message}` });
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
    handleCapture(message, sender.tab && sender.tab.id);
    return false; // pas de réponse attendue par content-isolated.js pour ce type
  }
  return false;
});
