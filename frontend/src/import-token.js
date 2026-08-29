import { apiGet, apiSend } from './api.js';
import { state } from './state.js';
import { API_BASE } from './api-base.js';

// ================= JETON D'IMPORT PERSONNEL (pont collecteur, admin/contributor) =================
// Simples enveloppes autour de l'API — la logique elle-même (génération, révocation, contrôle
// de rôle) vit entièrement côté serveur, voir backend/auth.js::generateImportToken() et
// resolveImportAuth()/requireImportAccess() dans backend/server.js. Ce jeton n'authentifie
// QUE POST /api/import (voir resolveImportAuth) — jamais une session complète : le perdre ne
// donne accès à rien d'autre qu'y pousser des parties.

// { token } — token vaut null si aucun n'a encore été généré.
export async function fetchImportToken() {
  return apiGet('/api/import-token');
}

export async function regenerateImportToken() {
  return apiSend('POST', '/api/import-token');
}

export async function revokeImportToken() {
  return apiSend('DELETE', '/api/import-token');
}

// Rendu + câblage du panneau dans #importScreen (voir frontend/index.html). Invisible pour un
// compte readonly (même contrôle de rôle qu'ailleurs dans l'app, voir applyRolePermissions()
// dans shell.js) : readonly n'a de toute façon pas le droit de pousser des données (voir
// requireImportAccess côté serveur), pas la peine de lui montrer un jeton inutilisable.
export async function renderImportTokenPanel() {
  const container = document.getElementById('importTokenPanel');
  if (!container) return;
  const user = state.currentUser;
  if (!user || user.role === 'readonly') {
    container.innerHTML = '';
    return;
  }
  let data;
  try {
    data = await fetchImportToken();
  } catch (e) {
    container.innerHTML = `<div class="import-error">Impossible de charger le jeton d'import : ${e.message}</div>`;
    return;
  }
  renderPanelContent(container, data.token);
  wirePanel(container);
}

// Sonde brièvement la présence de l'extension navigateur (voir browser-extension/content-
// isolated.js) via une poignée de main postMessage — jamais '*' en targetOrigin, toujours
// l'origine exacte de la page. Pas de réponse sous 300ms == pas installée (cas normal et
// attendu, pas une erreur) : le bouton reste affiché mais en état secondaire plutôt que
// bloquant, pour ne pas gêner les utilisateurs du userscript qui n'ont pas l'extension.
function detectExtension() {
  return new Promise((resolve) => {
    const origin = window.location.origin;
    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(false);
    }, 300);
    function handler(e) {
      if (e.source !== window || e.origin !== origin) return;
      if (!e.data || e.data.type !== 'EVA_DEBRIEF_PONG') return;
      clearTimeout(timeoutId);
      window.removeEventListener('message', handler);
      resolve(true);
    }
    window.addEventListener('message', handler);
    window.postMessage({ type: 'EVA_DEBRIEF_PING' }, origin);
  });
}

function renderPanelContent(container, token) {
  const tokenLine = token
    ? `<code class="import-token-value">${token}</code> <button class="btn small" id="copyImportTokenBtn">Copier</button>`
    : `<span style="color:var(--muted);">Aucun jeton actif.</span>`;
  container.innerHTML = `
    <h3>Pont automatique depuis le collecteur EVA</h3>
    <p>
      Configure le script collecteur (<code>eva_history_collector.user.js</code>) une seule
      fois avec ce jeton via son menu "Configurer EVA-Debrief" — il pousse ensuite tes parties
      et profils automatiquement en arrière-plan pendant que tu navigues normalement sur EVA,
      sans plus jamais avoir à télécharger ni réimporter de fichier à la main.
    </p>
    <p style="color:var(--muted);font-size:12px;">
      Ce jeton ne permet QUE d'envoyer des données à ce compte — il ne permet ni de se
      connecter, ni de consulter/modifier quoi que ce soit d'autre. Révoque/régénère-le à tout
      moment si besoin (ex: appareil perdu).
    </p>
    <div class="import-token-row">${tokenLine}</div>
    <div class="import-actions">
      <button class="btn small primary" id="regenImportTokenBtn">${token ? 'Régénérer' : 'Générer un jeton'}</button>
      ${token ? '<button class="btn small" id="revokeImportTokenBtn">Révoquer</button>' : ''}
    </div>
    <div class="import-extension-row">
      <button class="btn small" id="linkExtensionBtn">Lier l'extension EVA-Debrief</button>
      <div id="extensionLinkStatus" style="color:var(--muted);font-size:12px;margin-top:4px;"></div>
    </div>`;
  detectExtension().then((detected) => {
    const statusEl = container.querySelector('#extensionLinkStatus');
    if (!statusEl) return;
    if (!detected) {
      statusEl.textContent = "Extension non détectée — installe-la d'abord (voir browser-extension/README.md), puis recharge cette page.";
    }
  });
}

function wirePanel(container) {
  const copyBtn = document.getElementById('copyImportTokenBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const value = container.querySelector('.import-token-value').textContent;
      try {
        await navigator.clipboard.writeText(value);
        copyBtn.textContent = 'Copié !';
        setTimeout(() => { copyBtn.textContent = 'Copier'; }, 1500);
      } catch (e) {
        alert('Impossible de copier automatiquement — sélectionne le jeton à la main.');
      }
    });
  }
  document.getElementById('regenImportTokenBtn').addEventListener('click', async () => {
    if (!confirm('Générer un nouveau jeton invalide immédiatement l\'ancien (le collecteur déjà configuré ailleurs cessera de fonctionner tant qu\'il n\'est pas reconfiguré avec le nouveau). Continuer ?')) return;
    try {
      const { token } = await regenerateImportToken();
      renderPanelContent(container, token);
      wirePanel(container);
    } catch (e) {
      alert('Erreur lors de la génération du jeton : ' + e.message);
    }
  });
  const revokeBtn = document.getElementById('revokeImportTokenBtn');
  if (revokeBtn) {
    revokeBtn.addEventListener('click', async () => {
      if (!confirm('Révoquer ce jeton ? Le collecteur configuré avec ne pourra plus pousser de données tant que tu n\'en génères pas un nouveau.')) return;
      try {
        await revokeImportToken();
        renderPanelContent(container, null);
        wirePanel(container);
      } catch (e) {
        alert('Erreur lors de la révocation du jeton : ' + e.message);
      }
    });
  }
  document.getElementById('linkExtensionBtn').addEventListener('click', () => linkExtension(container));
}

// Round-trip postMessage vers l'extension (voir browser-extension/content-isolated.js) —
// jamais '*' en targetOrigin, toujours l'origine exacte de la page. Résout `null` si rien ne
// répond sous 3s (extension non installée ou pas encore injectée sur cette page).
function requestExtensionLink(backendUrl, importToken) {
  const origin = window.location.origin;
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 3000);
    function handler(e) {
      if (e.source !== window || e.origin !== origin) return;
      if (!e.data || e.data.type !== 'EVA_DEBRIEF_LINK_RESULT') return;
      clearTimeout(timeoutId);
      window.removeEventListener('message', handler);
      resolve(e.data);
    }
    window.addEventListener('message', handler);
    window.postMessage({ type: 'EVA_DEBRIEF_LINK_REQUEST', backendUrl, importToken }, origin);
  });
}

// Cœur du flux de liaison, indépendant de qui l'a déclenché (bouton sur la page, ou popup de
// l'extension via le relais EVA_DEBRIEF_TRIGGER_LINK plus bas) — un seul chemin, deux points
// d'entrée. Réutilise le jeton EXISTANT s'il y en a déjà un (ne régénère que si aucun n'existe
// encore) pour ne pas casser silencieusement une liaison userscript/extension déjà en place
// ailleurs, cohérent avec le geste volontaire déjà exigé pour "Régénérer". Renvoie toujours
// { ok, error? }, jamais null — jamais laisser l'appelant deviner un cas "pas de réponse".
async function performLink() {
  try {
    let { token } = await fetchImportToken();
    if (!token) {
      ({ token } = await regenerateImportToken());
      const container = document.getElementById('importTokenPanel');
      if (container) {
        renderPanelContent(container, token);
        wirePanel(container);
      }
    }
    const backendUrl = API_BASE || window.location.origin;
    const result = await requestExtensionLink(backendUrl, token);
    if (!result) return { ok: false, error: "Extension non détectée sur cette page." };
    return { ok: !!result.ok, error: result.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function linkExtension(container) {
  const statusEl = container.querySelector('#extensionLinkStatus');
  if (statusEl) statusEl.textContent = 'Liaison en cours…';
  const result = await performLink();
  if (!statusEl) return;
  if (result.ok) {
    statusEl.textContent = '✅ Extension liée avec succès. Navigue sur EVA normalement, la capture se fait automatiquement.';
  } else {
    statusEl.textContent = 'Échec de la liaison : ' + (result.error || 'erreur inconnue.') +
      (result.error === "Extension non détectée sur cette page." ? ' (voir browser-extension/README.md, puis recharge cette page)' : '');
  }
}

// Déclenché par le popup de l'extension (bouton "Lier ce compte" dans popup.js) plutôt que par
// un clic sur cette page — voir browser-extension/content-isolated.js pour le relais. Écouteur
// permanent posé une seule fois au chargement du module (pas à chaque rendu du panneau, pour
// ne pas en empiler un par connexion) ; le contrôle de rôle est refait ici à chaque déclenchement
// puisque `state.currentUser` peut changer entre-temps (déconnexion, changement de compte).
window.addEventListener('message', async (e) => {
  if (e.source !== window || e.origin !== window.location.origin) return;
  if (!e.data || e.data.type !== 'EVA_DEBRIEF_TRIGGER_LINK') return;
  const user = state.currentUser;
  if (!user || user.role === 'readonly') {
    window.postMessage({
      type: 'EVA_DEBRIEF_TRIGGER_LINK_RESULT',
      ok: false,
      error: "Connecte-toi sur EVA-Debrief avec un compte admin/contributor d'abord.",
    }, e.origin);
    return;
  }
  const result = await performLink();
  window.postMessage({ type: 'EVA_DEBRIEF_TRIGGER_LINK_RESULT', ...result }, e.origin);
});
