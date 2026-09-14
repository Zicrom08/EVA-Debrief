// ============================================================================
// EVA-Debrief — Collecteur automatique (extension)
// popup.js — bouton "Lier ce compte" à côté de la barre d'adresse, alternative au bouton sur
// la page EVA-Debrief elle-même (onglet "+ Importer" → panneau "Pont automatique") : les deux
// déclenchent exactement le même flux de liaison (voir content-isolated.js/import-token.js),
// simplement depuis deux endroits différents.
//
// Contrainte du popup : il faut être sur l'onglet EVA-Debrief qu'on veut lier au moment du
// clic (l'extension ne peut pas deviner laquelle, parmi tous les onglets ouverts, est une
// instance EVA-Debrief — chacune vit à une adresse choisie par son propriétaire, voir
// manifest.json). D'où l'usage de l'onglet ACTIF plutôt qu'une recherche sur tous les onglets.
// ============================================================================

const LOG = '[EVA-Debrief DEBUG]';
console.info(LOG, 'popup (debug) ouvert —', new Date().toISOString());

// Jeton masqué même en debug (4 premiers + 4 derniers caractères) : quelqu'un pourrait
// copier-coller ce log ailleurs (ex: pour me l'envoyer) sans faire attention.
function maskToken(token) {
  if (!token) return '(vide)';
  if (token.length <= 10) return '***';
  return token.slice(0, 4) + '…' + token.slice(-4) + ` (${token.length} caractères)`;
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['backendUrl', 'importToken', 'lastPushStatus'], (data) => {
      console.info(LOG, 'chrome.storage.local :', { ...data, importToken: maskToken(data.importToken) });
      resolve(data);
    });
  });
}

function renderStatus({ backendUrl, importToken, lastPushStatus }) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = (backendUrl && importToken) ? `Lié à ${backendUrl}` : 'Non lié.';

  // Cas spécifique diagnostiqué en pratique : host_permissions déclarées dans le manifest ne
  // suffisent pas si "Accès aux sites" (chrome://extensions → Détails) n'est pas sur "Sur tous
  // les sites" — le push échoue alors par CORS, sans aucun message ailleurs que la console du
  // service worker (voir background.js::handleCapture). Bannière dédiée avec correctif en un
  // clic plutôt que de laisser ça se confondre avec un échec réseau générique ci-dessous.
  const warnEl = document.getElementById('permissionWarning');
  warnEl.style.display = (lastPushStatus && !lastPushStatus.ok && lastPushStatus.permissionMissing) ? 'block' : 'none';

  const pushEl = document.getElementById('pushStatus');
  if (!lastPushStatus) {
    pushEl.textContent = '';
    return;
  }
  const when = new Date(lastPushStatus.at).toLocaleString();
  if (lastPushStatus.ok) {
    pushEl.textContent = `Dernier envoi (${when}) : ${lastPushStatus.addedGames || 0} partie(s), ${lastPushStatus.addedStats || 0} profil(s) ajoutés.`;
  } else if (lastPushStatus.permissionMissing) {
    pushEl.textContent = `Dernier envoi (${when}) : bloqué — voir ci-dessus.`;
  } else {
    pushEl.textContent = `Dernier envoi (${when}) : échec (${lastPushStatus.error || 'HTTP ' + lastPushStatus.httpStatus}).`;
  }
}

document.getElementById('openSiteAccessBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
});

async function refresh() {
  renderStatus(await getConfig());
}

document.getElementById('linkBtn').addEventListener('click', async () => {
  const linkStatusEl = document.getElementById('linkStatus');
  const btn = document.getElementById('linkBtn');
  btn.disabled = true;
  linkStatusEl.textContent = 'Liaison en cours…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      linkStatusEl.textContent = 'Aucun onglet actif.';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'EVA_DEBRIEF_TRIGGER_LINK' }, (result) => {
      btn.disabled = false;
      if (chrome.runtime.lastError) {
        linkStatusEl.textContent = "Cet onglet n'a pas répondu — es-tu bien sur ton instance EVA-Debrief ? (recharge la page si tu viens de l'ouvrir)";
        return;
      }
      if (!result) {
        linkStatusEl.textContent = "Pas de réponse de la page — es-tu bien connecté sur EVA-Debrief, avec un compte admin/contributor ?";
        return;
      }
      if (result.ok) {
        linkStatusEl.textContent = '✅ Lié avec succès.';
        refresh();
      } else {
        linkStatusEl.textContent = 'Échec : ' + (result.error || 'raison inconnue.');
      }
    });
  } catch (e) {
    btn.disabled = false;
    linkStatusEl.textContent = 'Erreur : ' + e.message;
  }
});

refresh();
