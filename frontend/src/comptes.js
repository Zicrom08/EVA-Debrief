import { state } from './state.js';
import { apiGet, apiSend, loadFromServer } from './api.js';
import { roleLabel, resolvePlayerName, nameFreshness, fmtDate } from './format.js';
import { linkPlayers, unlinkPlayer, aliasesOf } from './player-links.js';
import { setPlayerName, clearPlayerName } from './player-names.js';
import { detectTeamsFromNicknames } from './team-detect.js';
import { fetchBackups, backupNow } from './backups.js';
import { fetchSettings, updateRegistrationEnabled } from './settings.js';
import { rebuildPlayerIndex } from './player-index.js';
import { showApp } from './shell.js';

// ================= COMPTES (gestion des utilisateurs, réservé aux admins) =================
// Onglet visible seulement pour un compte admin (voir applyRolePermissions() dans shell.js) ;
// le serveur applique les mêmes règles indépendamment de l'UI (voir requireAdmin dans server.js).

let users = [];
let backupsData = { intervalHours: 0, retention: 0, sets: [] };
let settingsData = { registrationEnabled: true, turnstileConfigured: false };

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

// Une fusion/défusion/renommage/création d'équipe change l'identité, le nom affiché ou le
// roster de potentiellement tous les joueurs — on recharge tout depuis le serveur et on
// re-rend l'app entière (même logique que la suppression d'une partie, voir historique.js
// deleteGame()), plutôt que de tenter un rafraîchissement partiel forcément incomplet.
async function reloadAndRerenderApp() {
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
      await reloadAndRerenderApp();
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
      await reloadAndRerenderApp();
    });
  }
}

// ================= RENOMMAGE MANUEL DE JOUEUR (admin) =================
// Le pseudo affiché suit déjà automatiquement le plus récent vu en jeu (voir
// latestNiceName() dans format.js) — ce renommage forcé sert quand l'admin veut un nom
// différent de ce que le jeu renvoie littéralement (voir player-names.js). N'affecte
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
      await reloadAndRerenderApp();
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
      await reloadAndRerenderApp();
    });
  }
}

// ================= DÉTECTION AUTOMATIQUE D'ÉQUIPES PAR PSEUDO (admin) =================
// Voir team-detect.js pour la logique de détection elle-même (regex "TAGxPseudo", seuil de
// 2 membres minimum). Réutilise les routes /api/teams existantes (déjà réservées aux
// admins côté serveur, voir requireAdmin dans server.js) — aucune route dédiée nécessaire.
function findExistingTeamForTag(tag) {
  return Object.values(state.customTeams).find(t => t.name.toLowerCase() === tag.toLowerCase()) || null;
}

// Membres du candidat pas encore dans l'équipe existante (comparaison sur des uids déjà
// canoniques des deux côtés — voir player-links.js).
function newMembersFor(candidate, existingTeam) {
  if (!existingTeam) return candidate.members.map(m => m.uid);
  return candidate.members.map(m => m.uid).filter(uid => !existingTeam.members.includes(uid));
}

function renderTeamDetectionPanel() {
  const candidates = detectTeamsFromNicknames();
  if (!candidates.length) {
    return `<div style="color:var(--muted);font-size:13px;">
      Aucune équipe détectée dans les pseudos pour l'instant (motif attendu : "TAGxPseudo",
      au moins 2 joueurs partageant le même tag).
    </div>`;
  }

  const rows = candidates.map(c => {
    const existing = findExistingTeamForTag(c.tag);
    const newUids = newMembersFor(c, existing);
    const memberNames = c.members.map(m => resolvePlayerName(m.uid)).join(', ');

    let status, actionHtml;
    if (!existing) {
      status = `Nouvelle équipe (${c.members.length} joueur(s))`;
      actionHtml = `<button class="btn small primary" data-create-detected-team="${c.tag}">Créer</button>`;
    } else if (newUids.length) {
      status = `Équipe "${existing.name}" existante — ${newUids.length} nouveau(x) membre(s)`;
      actionHtml = `<button class="btn small primary" data-update-detected-team="${c.tag}">Ajouter</button>`;
    } else {
      status = `Équipe "${existing.name}" déjà à jour`;
      actionHtml = '';
    }

    return `
      <tr>
        <td class="name-cell">${c.tag}</td>
        <td style="color:var(--muted);font-size:12px;">${memberNames}</td>
        <td>${status}</td>
        <td class="num">${actionHtml}</td>
      </tr>`;
  }).join('');

  const hasActionable = candidates.some(c => {
    const existing = findExistingTeamForTag(c.tag);
    return !existing || newMembersFor(c, existing).length;
  });

  return `
    <div class="table-scroll"><table class="roster">
      <thead><tr><th>Tag détecté</th><th>Joueurs</th><th>Statut</th><th class="num">Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${hasActionable ? `<button class="btn small" id="applyAllDetectedTeamsBtn" style="margin-top:10px;">Tout créer / mettre à jour</button>` : ''}`;
}

// Crée l'équipe si elle n'existe pas encore, sinon lui ajoute les membres détectés
// manquants. Utilisé à la fois par les boutons par ligne et par "Tout créer / mettre à jour".
async function applyDetectedTeam(tag) {
  const candidate = detectTeamsFromNicknames().find(c => c.tag === tag);
  if (!candidate) return;
  const existing = findExistingTeamForTag(tag);
  if (!existing) {
    await apiSend('POST', '/api/teams', { name: candidate.tag, members: candidate.members.map(m => m.uid) });
    return;
  }
  const newUids = newMembersFor(candidate, existing);
  if (newUids.length) {
    await apiSend('PUT', `/api/teams/${existing.id}`, { members: [...existing.members, ...newUids] });
  }
}

function wireTeamDetectionManager() {
  document.querySelectorAll('[data-create-detected-team], [data-update-detected-team]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tag = btn.dataset.createDetectedTeam || btn.dataset.updateDetectedTeam;
      try {
        await applyDetectedTeam(tag);
      } catch (e) {
        alert("Erreur lors de la création/mise à jour de l'équipe : " + e.message);
        return;
      }
      await reloadAndRerenderApp();
    });
  });

  const applyAllBtn = document.getElementById('applyAllDetectedTeamsBtn');
  if (applyAllBtn) {
    applyAllBtn.addEventListener('click', async () => {
      const tags = detectTeamsFromNicknames().map(c => c.tag);
      try {
        for (const tag of tags) await applyDetectedTeam(tag);
      } catch (e) {
        alert("Erreur lors de la création/mise à jour des équipes : " + e.message);
        return;
      }
      await reloadAndRerenderApp();
    });
  }
}

// ================= SAUVEGARDES DE LA BASE (admin) =================
// Voir backups.js pour les appels API — la copie/purge elle-même vit côté serveur
// (backend/db.js). Contrairement aux autres panneaux ci-dessus, une sauvegarde ne change
// rien à l'affichage du reste de l'app : pas besoin de reloadAndRerenderApp(), un simple
// re-rendu de l'onglet Comptes suffit.
async function refreshBackupsFromServer() {
  backupsData = await fetchBackups();
}

function fmtBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function renderBackupsList(sets) {
  if (!sets.length) return `<div style="color:var(--muted);font-size:13px;">Aucune sauvegarde pour l'instant.</div>`;
  const rows = sets.map(s => {
    const totalSize = s.files.reduce((sum, f) => sum + f.size, 0);
    const links = s.files.map(f => `<a href="/api/backups/${f.name}">${f.kind}</a>`).join(' · ');
    return `
    <tr>
      <td class="name-cell">${fmtDate(s.createdAt)}</td>
      <td class="num">${fmtBytes(totalSize)}</td>
      <td class="num">${links}</td>
    </tr>`;
  }).join('');
  return `
    <div class="table-scroll"><table class="roster">
      <thead><tr><th>Date</th><th class="num">Taille</th><th class="num">Télécharger</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function renderBackupsPanel() {
  if (backupsData.error) {
    return `<div class="detail-empty">Impossible de charger les sauvegardes : ${backupsData.error}</div>`;
  }
  const freq = backupsData.intervalHours > 0
    ? `Sauvegarde automatique toutes les ${backupsData.intervalHours} heure(s), ${backupsData.retention} sauvegarde(s) conservée(s).`
    : `Sauvegarde automatique désactivée (BACKUP_INTERVAL_HOURS=0) — seule la sauvegarde manuelle ci-dessous est disponible.`;
  return `
    <div style="color:var(--muted);font-size:12px;margin-bottom:14px;">${freq}</div>
    <button class="btn small primary" id="backupNowBtn" style="margin-bottom:14px;">Sauvegarder maintenant</button>
    ${renderBackupsList(backupsData.sets)}`;
}

function wireBackupsManager() {
  const btn = document.getElementById('backupNowBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await backupNow();
        await refreshBackupsFromServer();
      } catch (e) {
        alert('Erreur lors de la sauvegarde : ' + e.message);
        btn.disabled = false;
        return;
      }
      renderComptes();
    });
  }
}

// ================= INSCRIPTION PUBLIQUE (admin) =================
// Bascule côté serveur (voir settings.js + /api/settings dans backend/server.js), séparée
// des variables d'environnement TURNSTILE_SITE_KEY/SECRET_KEY : celles-ci restent le
// prérequis technique (widget anti-bot configuré ou non), ce réglage ne fait que
// fermer/rouvrir temporairement le lien d'inscription PAR-DESSUS ce prérequis, sans
// redémarrer le serveur. Les deux doivent être vrais pour que /login.html propose le lien.
async function refreshSettingsFromServer() {
  settingsData = await fetchSettings();
}

function renderRegistrationPanel() {
  const { registrationEnabled, turnstileConfigured, error } = settingsData;
  if (error) {
    return `<div class="detail-empty">Impossible de charger ce réglage : ${error}</div>`;
  }
  const statusColor = registrationEnabled ? 'var(--win)' : 'var(--loss)';
  const statusLabel = registrationEnabled ? 'Ouverte' : 'Fermée';
  return `
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <div>État actuel : <strong style="color:${statusColor}">${statusLabel}</strong></div>
      <button class="btn small ${registrationEnabled ? 'danger' : 'primary'}" id="toggleRegistrationBtn">
        ${registrationEnabled ? 'Fermer les inscriptions' : 'Ouvrir les inscriptions'}
      </button>
    </div>
    ${!turnstileConfigured ? `<div style="color:var(--muted);font-size:11px;margin-top:10px;">
      ⚠️ TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY ne sont pas configurées sur le serveur — le
      lien d'inscription reste absent de /login.html quel que soit ce réglage, voir le README.
    </div>` : ''}`;
}

function wireRegistrationManager() {
  const btn = document.getElementById('toggleRegistrationBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        settingsData = await updateRegistrationEnabled(!settingsData.registrationEnabled);
      } catch (e) {
        alert('Erreur lors de la mise à jour du réglage : ' + e.message);
        btn.disabled = false;
        return;
      }
      renderComptes();
    });
  }
}

// ================= ANALYSE DES JOUEURS (admin) =================
// Rapport de contrôle sur les données déjà importées : pour chaque joueur connu, quel
// pseudo est actuellement retenu, d'où il vient (nameFreshness() dans format.js réutilise
// exactement le mécanisme de rebuildPlayerIndex()/latestNiceName() — même poids, même
// tri, aucune logique dupliquée) et depuis quand, pour vérifier d'un coup d'œil que
// l'actualisation automatique des pseudos (voir player-index.js) a bien tourné sur
// l'ensemble de la base, sans avoir à rouvrir chaque profil un par un.
function renderPlayerAnalysisPanel() {
  const rows = Object.entries(state.players).map(([uid, rec]) => ({
    uid,
    rec,
    info: nameFreshness(rec),
    snapshotCount: [uid, ...aliasesOf(uid)].reduce((sum, id) => sum + (state.playerStatsSnapshots[id] || []).length, 0),
    aliasCount: aliasesOf(uid).length,
  })).sort((a, b) => b.rec.games - a.rec.games);

  if (!rows.length) {
    return `<div style="color:var(--muted);font-size:13px;">Aucun joueur connu pour l'instant.</div>`;
  }

  const forcedCount = rows.filter(r => r.info.forced).length;
  const summary = `${rows.length} joueur(s) connu(s) — ${rows.length - forcedCount} avec pseudo auto-actualisé, ${forcedCount} avec un renommage forcé.`;

  const trs = rows.map(({ uid, rec, info, snapshotCount, aliasCount }) => `
    <tr>
      <td class="name-cell">${info.name} <span style="color:var(--muted);font-size:11px;">(#${uid})</span></td>
      <td>${info.forced ? '<span style="color:var(--gold);">Renommage forcé</span>' : (info.asOf ? fmtDate(info.asOf) : '—')}</td>
      <td class="num">${rec.games}</td>
      <td class="num">${snapshotCount}</td>
      <td class="num">${aliasCount || '—'}</td>
    </tr>`).join('');

  return `
    <div style="color:var(--muted);font-size:12px;margin-bottom:10px;">${summary}</div>
    <div class="table-scroll"><table class="roster">
      <thead><tr>
        <th>Joueur</th><th>Pseudo à jour depuis</th><th class="num">Parties</th>
        <th class="num">Captures profil</th><th class="num">Comptes fusionnés</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table></div>`;
}

// Le pseudo est déjà recalculé à chaque chargement (rebuildPlayerIndex() tourne au
// démarrage et après chaque import/fusion/renommage) — ce bouton ne fait donc que
// redemander l'état complet au serveur puis relancer ce même recalcul, utile si les
// données ont changé depuis ailleurs (import concurrent, autre onglet) sans qu'il y ait
// besoin d'une route ou d'une logique d'analyse séparée côté serveur.
function wirePlayerAnalysisManager() {
  const btn = document.getElementById('refreshAnalysisBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await reloadAndRerenderApp();
      } finally {
        btn.disabled = false;
      }
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
  try {
    await refreshBackupsFromServer();
  } catch (e) {
    backupsData = { intervalHours: 0, retention: 0, sets: [], error: e.message };
  }
  try {
    await refreshSettingsFromServer();
  } catch (e) {
    settingsData = { registrationEnabled: true, turnstileConfigured: false, error: e.message };
  }
  container.innerHTML = `
    <div class="team-manager">
      <div class="section-title">Comptes</div>
      ${renderUserList()}
      ${renderCreateForm()}
    </div>
    <div class="team-manager">
      <div class="section-title">Inscription publique</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:14px;">
        Ferme ou rouvre à tout moment le lien "Pas de compte ? Crée-en un" sur la page de
        connexion, sans toucher aux variables d'environnement ni redémarrer le serveur. Un
        compte créé via ce lien reste toujours en rôle lecture seule.
      </div>
      ${renderRegistrationPanel()}
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
        Le nom affiché suit déjà automatiquement le pseudo le plus récent vu en jeu — force
        ici un nom différent si besoin (ex: retirer un tag d'équipe de l'affichage).
        N'affecte aucune donnée de partie, toujours réversible.
      </div>
      ${renderPlayerNamesList()}
      ${renderPlayerNameForm()}
    </div>
    <div class="team-manager">
      <div class="section-title-row">
        <div class="section-title">Analyse des joueurs</div>
        <button class="btn small" id="refreshAnalysisBtn">Rafraîchir</button>
      </div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:14px;">
        État actuel du pseudo de chaque joueur connu, recalculé sur l'ensemble des parties
        et captures de profil déjà importées (le pseudo le plus récent des deux sources
        l'emporte automatiquement) — vérifie ici que l'actualisation a bien pris en compte
        tes dernières données.
      </div>
      ${renderPlayerAnalysisPanel()}
    </div>
    <div class="team-manager">
      <div class="section-title">Détection automatique d'équipes par pseudo</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:14px;">
        Détecte les équipes à partir des pseudos au format "TAGxJoueur" (ex: "BABOxViclegrand7")
        et propose de créer l'équipe correspondante ou d'y ajouter les nouveaux membres détectés.
      </div>
      ${renderTeamDetectionPanel()}
    </div>
    <div class="team-manager">
      <div class="section-title">Sauvegardes</div>
      ${renderBackupsPanel()}
    </div>`;
  wireUserManager();
  wireRegistrationManager();
  wirePlayerLinksManager();
  wirePlayerNamesManager();
  wirePlayerAnalysisManager();
  wireTeamDetectionManager();
  wireBackupsManager();
}
