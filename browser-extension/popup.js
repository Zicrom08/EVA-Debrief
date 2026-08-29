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

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['backendUrl', 'importToken', 'lastPushStatus'], resolve);
  });
}

function renderStatus({ backendUrl, importToken, lastPushStatus }) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = (backendUrl && importToken) ? `Lié à ${backendUrl}` : 'Non lié.';

  const pushEl = document.getElementById('pushStatus');
  if (!lastPushStatus) {
    pushEl.textContent = '';
    return;
  }
  const when = new Date(lastPushStatus.at).toLocaleString();
  if (lastPushStatus.ok) {
    pushEl.textContent = `Dernier envoi (${when}) : ${lastPushStatus.addedGames || 0} partie(s), ${lastPushStatus.addedStats || 0} profil(s) ajoutés.`;
  } else {
    pushEl.textContent = `Dernier envoi (${when}) : échec (${lastPushStatus.error || 'HTTP ' + lastPushStatus.httpStatus}).`;
  }
}

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
