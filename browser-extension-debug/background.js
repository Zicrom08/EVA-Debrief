// ============================================================================
// EVA-Debrief — Collecteur (DEBUG)
// Version instrumentée de background.js — identique à browser-extension/background.js
// dans sa logique, mais avec un log détaillé à CHAQUE étape (config lue, message reçu,
// URL exacte appelée, statut/en-têtes/corps de la réponse, erreur complète en cas
// d'échec). Voir browser-extension-debug/README.md pour comment l'utiliser et ce qu'il
// faut me renvoyer.
//
// Toute modification de comportement ici doit être reportée dans
// browser-extension/background.js (la version de prod) si elle s'avère être un vrai
// correctif, pas juste un ajout de logs — les deux fichiers ne sont PAS censés diverger
// en dehors de l'instrumentation.
// ============================================================================

const LOG = '[EVA-Debrief DEBUG]';
console.info(LOG, 'background.js (debug) chargé —', new Date().toISOString());

const CONFIG_KEYS = ['backendUrl', 'importToken'];

// Masque un jeton pour le log (4 premiers + 4 derniers caractères) — jamais le jeton en
// clair dans la console, même en debug : quelqu'un pourrait copier-coller ce log ailleurs.
function maskToken(token) {
  if (!token) return '(vide)';
  if (token.length <= 10) return '***';
  return token.slice(0, 4) + '…' + token.slice(-4) + ` (${token.length} caractères)`;
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(CONFIG_KEYS, (data) => {
      const cfg = { backendUrl: data.backendUrl || '', importToken: data.importToken || '' };
      console.log(LOG, 'Config lue depuis chrome.storage.local :', {
        backendUrl: cfg.backendUrl || '(vide)',
        importToken: maskToken(cfg.importToken),
      });
      resolve(cfg);
    });
  });
}

function isPlausibleUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function handleLinkRequest(message, sendResponse) {
  console.log(LOG, 'LINK_REQUEST reçu :', { backendUrl: message.backendUrl, importToken: maskToken(message.importToken) });
  const backendUrl = String(message.backendUrl || '').trim().replace(/\/+$/, '');
  const importToken = String(message.importToken || '').trim();
  if (!isPlausibleUrl(backendUrl) || !importToken) {
    console.warn(LOG, 'LINK_REQUEST rejeté : URL ou jeton invalide.', { backendUrl, hasToken: !!importToken });
    sendResponse({ ok: false, error: 'URL ou jeton invalide.' });
    return;
  }
  chrome.storage.local.set({ backendUrl, importToken }, () => {
    console.log(LOG, 'Liaison enregistrée avec succès :', { backendUrl, importToken: maskToken(importToken) });
    sendResponse({ ok: true });
  });
}

function setLastPushStatus(status) {
  chrome.storage.local.set({ lastPushStatus: { ...status, at: new Date().toISOString() } });
}

async function handleCapture({ nodes, playerStats }) {
  console.groupCollapsed(LOG, `EVA_CAPTURE reçu — ${nodes ? nodes.length : 0} partie(s), ${playerStats ? playerStats.length : 0} profil(s)`);
  try {
    const { backendUrl, importToken } = await getConfig();

    // Contrairement à la version de prod (no-op totalement silencieux si non lié — c'est
    // le comportement normal et attendu avant liaison), ici on log EXPLICITEMENT pourquoi
    // rien ne part, pour ne pas confondre "pont non lié" avec "push qui échoue".
    if (!backendUrl || !importToken) {
      console.warn(LOG, 'AUCUN PUSH ENVOYÉ : extension non liée (backendUrl ou importToken manquant dans chrome.storage.local). Utilise le popup ou le bouton "Lier l\'extension" sur EVA-Debrief.');
      console.groupEnd();
      return;
    }
    if (!(nodes && nodes.length) && !(playerStats && playerStats.length)) {
      console.warn(LOG, 'AUCUN PUSH ENVOYÉ : capture vide (0 partie, 0 profil) — rien à envoyer.');
      console.groupEnd();
      return;
    }

    // Vérification du VRAI consentement runtime, pas juste ce que déclare manifest.json :
    // host_permissions ("<all_urls>") ne suffit PAS à exempter un fetch() du CORS normal du
    // web si le réglage "Accès aux sites" de l'extension (chrome://extensions → Détails)
    // n'est pas sur "Sur tous les sites" — cause déjà identifiée en pratique (erreur "blocked
    // by CORS policy... preflight request" alors que le manifest déclare bien host_permissions).
    try {
      const originPattern = new URL(backendUrl).origin + '/*';
      const hasPerm = await new Promise((resolve) => chrome.permissions.contains({ origins: [originPattern] }, resolve));
      if (!hasPerm) {
        console.error(LOG, `⚠️ PERMISSION RUNTIME NON ACCORDÉE pour ${originPattern} — c'est très probablement LA cause d'un échec CORS qui va suivre. Va dans chrome://extensions → cette extension → Détails → "Accès aux sites" → sélectionne "Sur tous les sites" (pas "Sur clic"), puis recharge la page EVA et réessaie.`);
      } else {
        console.log(LOG, `Permission runtime pour ${originPattern} : ✅ accordée ("Accès aux sites" correctement sur "Sur tous les sites").`);
      }
    } catch (e) {
      console.warn(LOG, 'Impossible de vérifier chrome.permissions.contains() :', e.message);
    }

    const url = backendUrl + '/api/import';
    const payload = { nodes, playerStats };
    const bodyStr = JSON.stringify(payload);
    console.log(LOG, 'Envoi en cours :', {
      url,
      méthode: 'POST',
      tailleCorps: bodyStr.length + ' octets',
      idsPartiesEnvoyées: (nodes || []).map(n => n && n.id),
      idsJoueursProfilsEnvoyés: (playerStats || []).map(p => p && p.user && p.user.id),
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn(LOG, 'Délai de 15s dépassé — abandon de la requête (controller.abort()).');
      controller.abort();
    }, 15000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Import-Token': importToken },
        body: bodyStr,
        signal: controller.signal,
      });
      console.log(LOG, 'Réponse HTTP reçue :', {
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get('content-type'),
        url: res.url, // utile si une redirection a eu lieu (souvent signe d'une mauvaise URL configurée)
      });
      let bodyText = '';
      let body = {};
      try {
        bodyText = await res.text();
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch (e) {
        console.warn(LOG, 'Corps de la réponse non-JSON (affiché brut) :', bodyText);
      }
      if (!res.ok) {
        console.error(LOG, `ÉCHEC DU PUSH — HTTP ${res.status}`, body || bodyText);
        setLastPushStatus({ ok: false, httpStatus: res.status });
        console.groupEnd();
        return;
      }
      const added = (body.addedGames || 0) + (body.addedStats || 0);
      console.log(LOG, 'Corps de la réponse (parsé) :', body);
      if (added === 0) {
        console.warn(LOG, 'PUSH ACCEPTÉ (HTTP 200) MAIS RIEN AJOUTÉ — voir le détail ci-dessus (recognized/skippedPve/skippedInvalid/duplicateStats).');
      } else {
        console.log(LOG, `PUSH RÉUSSI — ${body.addedGames || 0} partie(s), ${body.addedStats || 0} profil(s) ajoutés.`);
      }
      setLastPushStatus({ ok: true, addedGames: body.addedGames || 0, addedStats: body.addedStats || 0 });
    } catch (e) {
      // e.name === 'AbortError' -> timeout ; e.name === 'TypeError' avec message "Failed to
      // fetch" -> le cas le plus fréquent en pratique : backend injoignable (mauvaise URL,
      // serveur éteint, certificat HTTPS invalide/auto-signé refusé, pas de réseau...).
      console.error(LOG, 'ÉCHEC DU PUSH — exception réseau :', { name: e.name, message: e.message, stack: e.stack });
      setLastPushStatus({ ok: false, error: e.message });
    } finally {
      clearTimeout(timeoutId);
    }
  } finally {
    console.groupEnd();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG, 'Message reçu par le service worker :', message && message.type, '— depuis', sender && sender.url);
  if (message.type === 'LINK_REQUEST') {
    handleLinkRequest(message, sendResponse);
    return true;
  }
  if (message.type === 'EVA_CAPTURE') {
    handleCapture(message);
    return false;
  }
  console.warn(LOG, 'Type de message non reconnu, ignoré :', message);
  return false;
});
