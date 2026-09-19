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
// tentative EN PLUS de l'encart dans la page (sendToast ci-dessous, canal principal — voir
// handleCapture), au cas où les notifications système fonctionnent réellement chez cet
// utilisateur. Déclenchée uniquement quand quelque chose a vraiment été ajouté (jamais à
// chaque capture, basé sur addedGames/addedStats renvoyés par le serveur — pas sur la simple
// présence de nodes/playerStats dans la requête, qui peut très bien ne rien contenir de
// nouveau, ex: re-parcourir des pages déjà capturées).
function notify(id, title, message) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
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

// ---------------------------------------------------------------------------
// Regroupement des captures rapprochées dans le temps (voir handleCapture) : la pagination
// automatique de l'historique (AUTO_PAGE_DELAY_MS = 600ms dans content-main-world.js) déclenche
// un handleCapture()/push séparé par page, jusqu'à 60 pour une saison complète — sans
// regroupement, "Import en cours" / "Import terminé" clignotait à chaque page (signalé en
// pratique). Un seul cycle par onglet : "en cours" affiché à la toute première capture d'un
// lot, totaux accumulés au fil des pushes, "terminé" annoncé seulement FLUSH_DELAY_MS après la
// DERNIÈRE réponse reçue (le minuteur est reposé à chaque réponse, pas seulement au début) —
// largement au-dessus de l'intervalle de pagination pour absorber toute une rafale de pages
// dans un seul cycle, sans pour autant faire attendre inutilement un import isolé.
// ---------------------------------------------------------------------------
const FLUSH_DELAY_MS = 2000;
const pendingByTab = new Map(); // tabId -> { games, stats, sawError, timer }

function ensurePending(tabId) {
  let p = pendingByTab.get(tabId);
  if (!p) {
    p = { games: 0, stats: 0, sawError: false, timer: null };
    pendingByTab.set(tabId, p);
    sendToast(tabId, { kind: 'info', title: 'EVA-Debrief', message: 'Import en cours…', sticky: true });
  }
  return p;
}

function scheduleFinish(tabId, pending) {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => finishPending(tabId), FLUSH_DELAY_MS);
}

// Affiche les messages en séquence (jamais simultanément) plutôt que de laisser le second
// écraser instantanément le premier — un seul encart à la fois côté page (voir showToast dans
// content-isolated.js), donc parties et profil peuvent tout à fait se conclure au même moment
// (ex: une page qui déclenche les deux requêtes) sans que l'un des deux messages ne soit jamais
// visible.
function finishPending(tabId) {
  const p = pendingByTab.get(tabId);
  if (!p) return;
  pendingByTab.delete(tabId);

  const toasts = [];
  if (p.games > 0) {
    const msg = `Import des parties terminé : ${p.games} nouvelle(s) partie(s) ajoutée(s).`;
    toasts.push({ kind: 'success', title: 'EVA-Debrief', message: msg });
    notify('eva-debrief-games', 'EVA-Debrief', msg);
  }
  if (p.stats > 0) {
    const msg = 'Statistiques de profil mises à jour.';
    toasts.push({ kind: 'success', title: 'EVA-Debrief', message: msg });
    notify('eva-debrief-stats', 'EVA-Debrief', msg);
  }
  if (!toasts.length) {
    toasts.push(p.sawError
      ? { kind: 'error', title: 'EVA-Debrief', message: "Échec de l'import — voir la console de l'extension (clic droit sur l'icône → Inspecter le service worker)." }
      : { kind: 'info', title: 'EVA-Debrief', message: 'Import terminé — rien de nouveau à ajouter.' });
  }
  toasts.forEach((t, i) => setTimeout(() => sendToast(tabId, t), i * 3500));
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
    sendToast(tabId, { kind: 'error', title: 'EVA-Debrief', message: "Permission de site manquante — voir chrome://extensions → Détails → \"Accès aux sites\"." });
    return;
  }

  const pending = ensurePending(tabId);
  scheduleFinish(tabId, pending);

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
      pending.sawError = true;
      return;
    }
    if ((body.addedGames || 0) + (body.addedStats || 0) === 0) {
      console.warn('[EVA-Debrief] Push accepté mais rien de nouveau ajouté :', body);
    }
    pending.games += body.addedGames || 0;
    pending.stats += body.addedStats || 0;
    setLastPushStatus({ ok: true, addedGames: body.addedGames || 0, addedStats: body.addedStats || 0 });
  } catch (e) {
    console.warn('[EVA-Debrief] Échec du push (réseau/délai dépassé) :', e.message);
    setLastPushStatus({ ok: false, error: e.message });
    pending.sawError = true;
  } finally {
    clearTimeout(timeoutId);
    // Reposé après la réponse (ou l'échec) de CETTE requête, pas seulement au début — sinon le
    // minuteur posé au tout premier "en cours" pourrait expirer pendant qu'une page de
    // pagination est encore en vol.
    scheduleFinish(tabId, pending);
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
