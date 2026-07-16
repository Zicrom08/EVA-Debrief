import { state } from './state.js';

export function fmtDuration(sec){
  sec = sec || 0;
  const m = Math.floor(sec/60), s = sec%60;
  return `${m}:${String(s).padStart(2,'0')}`;
}
// Formate une date ISO en date + heure lisibles (français).
export function fmtDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', {day:'2-digit',month:'short'}) + ' · ' +
         d.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
}
// Formate une date ISO en date courte (jour/mois).
export function fmtDateShort(iso){
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', {day:'2-digit',month:'short',year:'2-digit'});
}
// Retrouve l'entrée d'un joueur (par userId) parmi les participants d'une partie.
export function findPlayerInGame(g, uid){
  return (g.players||[]).find(p => p.userId == uid);
}
// Raccourci pour retrouver le joueur actuellement sélectionné (state.currentUid) dans une partie.
export function findSelf(g){ return findPlayerInGame(g, state.currentUid); }

// Renvoie le pseudo le plus fréquent d'un joueur (gère les changements de tag/pseudo au fil du temps).
export function mostCommonName(rec){
  return Object.entries(rec.niceNames).sort((a,b)=>b[1]-a[1])[0][0];
}

// Formate un nombre en notation française, avec un nombre de décimales personnalisable.
export function niceNum(n, decimals) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString('fr-FR', { maximumFractionDigits: decimals != null ? decimals : 1 });
}

// Formate un delta avec un "+" explicite pour les valeurs positives (les stats de
// saison ne devraient jamais reculer, mais un "+" rend la lecture immédiate).
export function fmtDelta(n, decimals) {
  decimals = decimals != null ? decimals : 0;
  const v = Number(n) || 0;
  const sign = v > 0 ? '+' : '';
  return sign + v.toLocaleString('fr-FR', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

// Formate une durée en secondes en "X h Y min".
export function fmtHM(sec) {
  sec = sec || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}
