import { apiGet, apiSend } from './api.js';
import { state } from './state.js';

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
    </div>`;
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
}
