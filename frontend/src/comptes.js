import { state } from './state.js';
import { apiGet, apiSend } from './api.js';
import { roleLabel } from './format.js';

// ================= COMPTES (gestion des utilisateurs, réservé aux admins) =================
// Onglet visible seulement pour un compte admin (voir applyRolePermissions() dans shell.js) ;
// le serveur applique les mêmes règles indépendamment de l'UI (voir requireAdmin dans server.js).

let users = [];

const ROLES = ['admin', 'contributor', 'readonly'];
function roleOptionsHtml(selectedRole) {
  return ROLES.map(r => `<option value="${r}" ${r === selectedRole ? 'selected' : ''}>${roleLabel(r)}</option>`).join('');
}

function renderUserList() {
  if (!users.length) return `<div style="color:var(--muted);font-size:13px;">Aucun compte.</div>`;
  const adminCount = users.filter(u => u.role === 'admin').length;
  const rows = users.map(u => {
    const isSelf = state.currentUser && state.currentUser.id === u.id;
    const isLastAdmin = u.role === 'admin' && adminCount <= 1;
    return `
    <tr>
      <td class="name-cell">${u.username}${isSelf ? ' <span style="color:var(--muted);">(toi)</span>' : ''}</td>
      <td>
        <select data-role-select="${u.id}" ${isSelf || isLastAdmin ? 'disabled' : ''}>
          ${roleOptionsHtml(u.role)}
        </select>
      </td>
      <td class="num">
        <button class="btn small" data-reset-password="${u.id}">Changer le mot de passe</button>
        <button class="btn small danger" data-delete-user="${u.id}" ${isSelf || isLastAdmin ? 'disabled' : ''} title="${isSelf ? 'Impossible de supprimer son propre compte' : isLastAdmin ? 'Impossible de supprimer le dernier administrateur' : 'Supprimer ce compte'}">✕</button>
      </td>
    </tr>`;
  }).join('');
  return `
    <div class="table-scroll"><table class="roster">
      <thead><tr><th>Compte</th><th>Rôle</th><th class="num">Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function renderCreateForm() {
  return `
    <div class="team-create-form">
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Créer un nouveau compte :</div>
      <input type="text" id="newUserName" placeholder="Nom d'utilisateur">
      <input type="password" id="newUserPassword" placeholder="Mot de passe (8 caractères min.)">
      <select id="newUserRole">
        ${roleOptionsHtml('readonly')}
      </select>
      <button class="btn primary small" id="createUserBtn">+ Créer</button>
    </div>`;
}

async function refreshUsersFromServer() {
  users = await apiGet('/api/users');
}

function wireUserManager() {
  document.querySelectorAll('[data-role-select]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.roleSelect;
      try {
        await apiSend('PUT', `/api/users/${id}`, { role: sel.value });
      } catch (e) {
        alert('Erreur lors du changement de rôle : ' + e.message);
      }
      renderComptes();
    });
  });

  document.querySelectorAll('[data-reset-password]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.resetPassword;
      const password = prompt('Nouveau mot de passe (8 caractères min.) :');
      if (!password) return;
      try {
        await apiSend('PUT', `/api/users/${id}`, { password });
        alert('Mot de passe mis à jour.');
      } catch (e) {
        alert('Erreur lors du changement de mot de passe : ' + e.message);
      }
    });
  });

  document.querySelectorAll('[data-delete-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteUser;
      const user = users.find(u => u.id === id);
      if (!confirm(`Supprimer le compte "${user?.username || ''}" ?`)) return;
      try {
        await apiSend('DELETE', `/api/users/${id}`);
      } catch (e) {
        alert('Erreur lors de la suppression du compte : ' + e.message);
      }
      renderComptes();
    });
  });

  const createBtn = document.getElementById('createUserBtn');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const nameInput = document.getElementById('newUserName');
      const passwordInput = document.getElementById('newUserPassword');
      const roleSelect = document.getElementById('newUserRole');
      const username = nameInput.value.trim();
      const password = passwordInput.value;
      if (!username) { nameInput.focus(); return; }
      if (password.length < 8) { alert('Le mot de passe doit faire au moins 8 caractères.'); passwordInput.focus(); return; }
      try {
        await apiSend('POST', '/api/users', { username, password, role: roleSelect.value });
      } catch (e) {
        alert('Erreur lors de la création du compte : ' + e.message);
      }
      renderComptes();
    });
  }
}

// Point d'entrée de l'onglet Comptes.
export async function renderComptes() {
  const container = document.getElementById('comptesContent');
  try {
    await refreshUsersFromServer();
  } catch (e) {
    container.innerHTML = `<div class="detail-empty">Impossible de charger les comptes : ${e.message}</div>`;
    return;
  }
  container.innerHTML = `
    <div class="team-manager">
      <div class="section-title">Comptes</div>
      ${renderUserList()}
      ${renderCreateForm()}
    </div>`;
  wireUserManager();
}
