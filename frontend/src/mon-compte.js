import { state } from './state.js';
import { changeMyPassword, deleteMyAccount } from './api.js';
import { roleLabel } from './format.js';
import { clearAuthToken, pageUrl } from './api-base.js';

// ================= MON COMPTE (self-service, tous rôles) =================
// Distinct de l'onglet Comptes (gestion de TOUS les comptes, admin uniquement, voir
// comptes.js) : ici chaque compte ne gère QUE le sien — changer son propre mot de passe ou
// supprimer son propre compte, actions qu'un readonly/contributor ne pouvait faire nulle
// part avant (seul un admin pouvait réinitialiser le mot de passe d'un AUTRE compte, ou
// supprimer un AUTRE compte — jamais le sien, voir requireAdmin dans server.js). Toujours
// visible dans la barre d'onglets, quel que soit le rôle (voir index.html/shell.js —
// contrairement à comptesTabBtn, pas de masquage conditionnel).

function renderAccountInfo() {
  const user = state.currentUser;
  if (!user) return '';
  return `
    <div style="color:var(--muted);font-size:12px;">
      Connecté en tant que <strong style="color:var(--text);">${user.username}</strong>${user.email ? ` (${user.email})` : ''}
      — rôle <strong style="color:var(--text);">${roleLabel(user.role)}</strong>.
    </div>`;
}

function renderChangePasswordForm() {
  return `
    <div class="team-create-form">
      <input type="password" id="currentPasswordInput" placeholder="Mot de passe actuel" autocomplete="current-password">
      <input type="password" id="newPasswordInput" placeholder="Nouveau mot de passe (8 caractères min.)" autocomplete="new-password">
      <input type="password" id="confirmPasswordInput" placeholder="Confirmer le nouveau mot de passe" autocomplete="new-password">
      <button class="btn primary small" id="changePasswordBtn">Changer le mot de passe</button>
    </div>`;
}

function renderDeleteAccountForm() {
  return `
    <div class="team-create-form">
      <input type="password" id="deleteAccountPasswordInput" placeholder="Mot de passe actuel" autocomplete="current-password">
      <button class="btn small danger" id="deleteAccountBtn">Supprimer définitivement mon compte</button>
    </div>`;
}

// Même logique de déconnexion que logoutBtn (shell.js), sans appeler POST /api/logout : la
// session vient déjà d'être détruite côté serveur (voir auth.destroySessionsForUser() dans
// PUT /api/me/password et DELETE /api/me) — l'appeler ici échouerait de toute façon en 401.
function forceLogoutAndRedirect() {
  clearAuthToken();
  window.location.href = pageUrl('login.html');
}

function wirePanel() {
  document.getElementById('changePasswordBtn').addEventListener('click', async () => {
    const currentPassword = document.getElementById('currentPasswordInput').value;
    const newPassword = document.getElementById('newPasswordInput').value;
    const confirmPassword = document.getElementById('confirmPasswordInput').value;
    if (!currentPassword) { alert('Renseigne ton mot de passe actuel.'); return; }
    if (newPassword.length < 8) { alert('Le nouveau mot de passe doit faire au moins 8 caractères.'); return; }
    if (newPassword !== confirmPassword) { alert('Les deux mots de passe ne correspondent pas.'); return; }
    try {
      await changeMyPassword(currentPassword, newPassword);
    } catch (e) {
      alert('Erreur lors du changement de mot de passe : ' + e.message);
      return;
    }
    alert('Mot de passe changé — reconnecte-toi avec ton nouveau mot de passe.');
    forceLogoutAndRedirect();
  });

  document.getElementById('deleteAccountBtn').addEventListener('click', async () => {
    const password = document.getElementById('deleteAccountPasswordInput').value;
    if (!password) { alert('Renseigne ton mot de passe pour confirmer.'); return; }
    if (!confirm('Supprimer définitivement ton compte ? Cette action est irréversible. Les parties déjà importées ne sont pas supprimées (elles restent partagées avec les autres comptes) — seuls ton compte et tes groupes de parties privés le sont.')) return;
    try {
      await deleteMyAccount(password);
    } catch (e) {
      alert('Erreur lors de la suppression du compte : ' + e.message);
      return;
    }
    forceLogoutAndRedirect();
  });
}

// Point d'entrée de l'onglet Mon compte.
export function renderMonCompte() {
  const container = document.getElementById('moncompteContent');
  if (!container) return;
  container.innerHTML = `
    <div class="team-manager">
      <div class="section-title">Mon compte</div>
      ${renderAccountInfo()}
    </div>
    <div class="team-manager">
      <div class="section-title">Changer mon mot de passe</div>
      ${renderChangePasswordForm()}
    </div>
    <div class="team-manager">
      <div class="section-title">Zone dangereuse</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:14px;">
        Supprime définitivement ton compte. N'affecte aucune partie déjà importée (les
        données restent partagées avec les autres comptes) — seuls ton compte et tes groupes
        de parties privés sont supprimés.
      </div>
      ${renderDeleteAccountForm()}
    </div>`;
  wirePanel();
}
