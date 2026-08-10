import { state } from './state.js';

// Redirige vers la page de connexion (session expirée ou absente).
export function redirectToLogin() {
  window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname + window.location.search);
}

// Requête GET vers l'API du serveur ; redirige vers /login.html si la session a expiré (401).
export async function apiGet(path) {
  const res = await fetch(path);
  if (res.status === 401) { redirectToLogin(); throw new Error('session expirée'); }
  if (!res.ok) throw new Error(`API ${path} → HTTP ${res.status}`);
  return res.json();
}
// Requête POST/PUT/DELETE vers l'API du serveur avec un corps JSON.
export async function apiSend(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { redirectToLogin(); throw new Error('session expirée'); }
  if (!res.ok) {
    let msg = `API ${path} → HTTP ${res.status}`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

// Compte courant (username + rôle) — utilisé pour adapter l'UI selon le rôle.
export async function getMe() {
  return apiGet('/api/me');
}

// Recharge state.gamesById / state.playerStatsSnapshots / state.customTeams / state.playerLinks / state.playerNames depuis le serveur.
// C'est la SEULE source de vérité pour ces données — après un import, on ne fusionne
// jamais localement : on redemande l'état complet au serveur pour être sûr d'avoir
// exactement ce qui est en base (déduplication comprise).
export async function loadFromServer() {
  const serverState = await apiGet('/api/state');
  state.gamesById = {};
  (serverState.games || []).forEach(g => { if (g && g.id != null) state.gamesById[g.id] = g; });

  state.playerStatsSnapshots = {};
  (serverState.playerStats || []).forEach(s => {
    if (!s || !s.user || s.user.id == null) return;
    const uid = s.user.id;
    if (!state.playerStatsSnapshots[uid]) state.playerStatsSnapshots[uid] = [];
    state.playerStatsSnapshots[uid].push(s);
  });
  Object.keys(state.playerStatsSnapshots).forEach(uid => {
    state.playerStatsSnapshots[uid].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
  });

  state.customTeams = {};
  (serverState.teams || []).forEach(t => { state.customTeams[t.id] = t; });

  state.playerLinks = {};
  (serverState.playerLinks || []).forEach(l => {
    if (l && l.aliasUserId != null) state.playerLinks[l.aliasUserId] = l.primaryUserId;
  });

  state.playerNames = {};
  (serverState.playerNames || []).forEach(n => {
    if (n && n.uid != null) state.playerNames[n.uid] = n.name;
  });
}
