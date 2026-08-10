import { state } from './state.js';
import { apiGet, apiSend, loadFromServer } from './api.js';
import { roleLabel, resolvePlayerName } from './format.js';
import { linkPlayers, unlinkPlayer } from './player-links.js';
import { setPlayerName, clearPlayerName } from './player-names.js';
import { rebuildPlayerIndex } from './player-index.js';
import { showApp } from './shell.js';

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
      <td style="color:var(--muted);">${u.email || '—'}</td>
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
      <thead><tr><th>Compte</th><th>Email</th><th>Rôle</th><th class="num">Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function renderCreateForm() {
  return `
    <div class="team-create-form">
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Créer un nouveau compte :</div>
      <input type="text" id="newUserName" placeholder="Nom d'utilisateur">
      <input type="email" id="newUserEmail" placeholder="Adresse email (optionnel)">
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
      const emailInput = document.getElementById('newUserEmail');
      const passwordInput = document.getElementById('newUserPassword');
      const roleSelect = document.getElementById('newUserRole');
      const username = nameInput.value.trim();
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!username) { nameInput.focus(); return; }
      if (password.length < 8) { alert('Le mot de passe doit faire au moins 8 caractères.'); passwordInput.focus(); return; }
      try {
        await apiSend('POST', '/api/users', { username, email, password, role: roleSelect.value });
      } catch (e) {
        alert('Erreur lors de la création du compte : ' + e.message);
      }
      renderComptes();
    });
  }
}

// ================= FUSION DE COMPTES JOUEURS (admin) =================
// Distinct des comptes EVA Debrief ci-dessus (login/rôles) : ici on fusionne des comptes
// EVA (smurfs) entre eux pour agréger leurs stats côté client — voir player-links.js. Ne
// modifie jamais une partie ou une capture stockée, toujours réversible (défusion).

// Tous les userId EVA bruts jamais vus (parties + captures de profil), fusionnés ou non —
// vivier du sélecteur "compte à fusionner" (state.players, lui, n'est indexé QUE par
// identifiant canonique, donc insuffisant pour lister les comptes encore fusionnables).
function allRawPlayerIds() {
  const ids = new Set();
  Object.values(state.gamesById).forEach(g => (g.players || []).forEach(p => {
    if (p.userId != null) ids.add(String(p.userId));
  }));
  Object.keys(state.playerStatsSnapshots).forEach(uid => ids.add(String(uid)));
  return Array.from(ids);
}

function renderPlayerLinksList() {
  const links = Object.entries(state.playerLinks);
  if (!links.length) return `<div style="color:var(--muted);font-size:13px;">Aucune fusion active.</div>`;
  const rows = links.map(([aliasUserId, primaryUserId]) => `
    <tr>
      <td class="name-cell">${resolvePlayerName(aliasUserId)} <span style="color:var(--muted);font-size:11px;">(#${aliasUserId})</span></td>
      <td class="num">→</td>
      <td class="name-cell">${resolvePlayerName(primaryUserId)}</td>
      <td class="num"><button class="btn small danger" data-unlink-player="${aliasUserId}">Défusionner</button></td>
    </tr>`).join('');
  return `
    <div class="table-scroll"><table class="roster">
      <thead><tr><th>Compte fusionné</th><th></th><th>Compte principal</th><th class="num">Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function renderPlayerLinkForm() {
  const primaries = Object.entries(state.players)
    .map(([uid, rec]) => ({ uid, name: resolvePlayerName(uid), games: rec.games }))
    .sort((a, b) => b.games - a.games);
  const aliasCandidates = allRawPlayerIds()
    .map(uid => ({ uid, name: resolvePlayerName(uid) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!aliasCandidates.length) {
    return `<div style="color:var(--muted);font-size:12px;margin-top:10px;">Importe d'abord des parties ou des profils pour pouvoir fusionner des comptes.</div>`;
  }

  return `
    <div class="team-create-form">
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Fusionner un compte EVA (smurf) dans un autre :</div>
      <select id="mergeAliasSelect">
        <option value="">— compte à fusionner —</option>
        ${aliasCandidates.map(p => `<option value="${p.uid}">${p.name} (#${p.uid})</option>`).join('')}
      </select>
      <select id="mergePrimarySelect">
        <option value="">— fusionner dans —</option>
        ${primaries.map(p => `<option value="${p.uid}">${p.name} (${p.games} partie(s))</option>`).join('')}
      </select>
      <button class="btn primary small" id="mergePlayersBtn">Fusionner</button>
    </div>`;
}

// Une fusion/défusion/renommage change l'identité ou le nom affiché de potentiellement
// tous les joueurs — on recharge tout depuis le serveur et on re-rend l'app entière (même
// logique que la suppression d'une partie, voir historique.js deleteGame()), plutôt que de
// tenter un rafraîchissement partiel forcément incomplet.
async function reloadAfterPlayerIdentityChange() {
  await loadFromServer();
  rebuildPlayerIndex();
  renderComptes();
  showApp();
}

function wirePlayerLinksManager() {
  document.querySelectorAll('[data-unlink-player]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const aliasUserId = btn.dataset.unlinkPlayer;
      if (!confirm('Défusionner ce compte ? Il redeviendra un joueur autonome dans les statistiques.')) return;
      try {
        await unlinkPlayer(aliasUserId);
      } catch (e) {
        alert('Erreur lors de la défusion : ' + e.message);
        return;
      }
      await reloadAfterPlayerIdentityChange();
    });
  });

  const mergeBtn = document.getElementById('mergePlayersBtn');
  if (mergeBtn) {
    mergeBtn.addEventListener('click', async () => {
      const aliasUserId = document.getElementById('mergeAliasSelect').value;
      const primaryUserId = document.getElementById('mergePrimarySelect').value;
      if (!aliasUserId || !primaryUserId) return;
      if (aliasUserId === primaryUserId) { alert('Choisis deux comptes différents.'); return; }
      try {
        await linkPlayers(aliasUserId, primaryUserId);
      } catch (e) {
        alert('Erreur lors de la fusion : ' + e.message);
        return;
      }
      await reloadAfterPlayerIdentityChange();
    });
  }
}

// ================= RENOMMAGE MANUEL DE JOUEUR (admin) =================
// Force le nom affiché d'un joueur — utile quand il a changé de pseudo en jeu et que
// l'ancien reste "le plus fréquent" statistiquement (voir player-names.js). N'affecte
// aucune donnée de partie, toujours réversible.
function renderPlayerNamesList() {
  const entries = Object.entries(state.playerNames);
  if (!entries.length) return `<div style="color:var(--muted);font-size:13px;">Aucun renommage manuel.</div>`;
  const rows = entries.map(([uid, name]) => `
    <tr>
      <td class="name-cell">${name} <span style="color:var(--muted);font-size:11px;">(#${uid})</span></td>
      <td class="num"><button class="btn small danger" data-reset-player-name="${uid}">Réinitialiser</button></td>
    </tr>`).join('');
  return `
    <div class="table-scroll"><table class="roster">
      <thead><tr><th>Joueur renommé</th><th class="num">Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function renderPlayerNameForm() {
  const players = Object.entries(state.players)
    .map(([uid, rec]) => ({ uid, name: resolvePlayerName(uid), games: rec.games }))
    .sort((a, b) => b.games - a.games);

  if (!players.length) {
    return `<div style="color:var(--muted);font-size:12px;margin-top:10px;">Importe d'abord des parties ou des profils pour pouvoir renommer un joueur.</div>`;
  }

  return `
    <div class="team-create-form">
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Renommer un joueur (après un changement de pseudo en jeu, par exemple) :</div>
      <select id="renamePlayerSelect">
        <option value="">— choisir un joueur —</option>
        ${players.map(p => `<option value="${p.uid}">${p.name} (#${p.uid})</option>`).join('')}
      </select>
      <input type="text" id="renamePlayerInput" placeholder="Nouveau nom affiché">
      <button class="btn primary small" id="renamePlayerBtn">Renommer</button>
    </div>`;
}

function wirePlayerNamesManager() {
  document.querySelectorAll('[data-reset-player-name]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.dataset.resetPlayerName;
      if (!confirm('Revenir au pseudo auto-détecté pour ce joueur ?')) return;
      try {
        await clearPlayerName(uid);
      } catch (e) {
        alert('Erreur lors de la réinitialisation du nom : ' + e.message);
        return;
      }
      await reloadAfterPlayerIdentityChange();
    });
  });

  const renameBtn = document.getElementById('renamePlayerBtn');
  if (renameBtn) {
    renameBtn.addEventListener('click', async () => {
      const uid = document.getElementById('renamePlayerSelect').value;
      const nameInput = document.getElementById('renamePlayerInput');
      const name = nameInput.value.trim();
      if (!uid) return;
      if (!name) { nameInput.focus(); return; }
      try {
        await setPlayerName(uid, name);
      } catch (e) {
        alert('Erreur lors du renommage : ' + e.message);
        return;
      }
      await reloadAfterPlayerIdentityChange();
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
    </div>
    <div class="team-manager">
      <div class="section-title">Fusion de comptes joueurs</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:14px;">
        Regroupe plusieurs comptes EVA (smurfs) d'une même personne sous un seul profil dans
        toutes les stats de l'app. Ne modifie aucune partie ni capture stockée — toujours réversible.
      </div>
      ${renderPlayerLinksList()}
      ${renderPlayerLinkForm()}
    </div>
    <div class="team-manager">
      <div class="section-title">Renommer un joueur</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:14px;">
        Force le nom affiché d'un joueur (utile s'il a changé de pseudo en jeu et que
        l'ancien reste "le plus fréquent" statistiquement). N'affecte aucune donnée de
        partie, toujours réversible.
      </div>
      ${renderPlayerNamesList()}
      ${renderPlayerNameForm()}
    </div>`;
  wireUserManager();
  wirePlayerLinksManager();
  wirePlayerNamesManager();
}
