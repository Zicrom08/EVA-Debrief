import { state } from './state.js';
import { latestNiceName } from './format.js';
import { canonicalUid } from './player-links.js';
import { applyPlayerNameOverrides } from './player-names.js';
import { persistUiPrefs } from './ui-prefs.js';
import { renderSummary } from './shell.js';
import { renderList } from './historique.js';
import { renderTrends } from './tendances.js';
import { renderComparatif } from './comparatif.js';
import { renderProfil } from './profil/index.js';

// ================= PLAYER INDEX (from game history) =================
// Indexé par identifiant CANONIQUE (voir player-links.js) : un joueur fusionné avec un
// smurf apparaît comme une seule entrée agrégeant les parties des deux comptes, quel que
// soit celui qui a réellement joué chaque partie.
export function rebuildPlayerIndex() {
  state.players = {};
  Object.values(state.gamesById).forEach(g => {
    (g.players || []).forEach(p => {
      const uid = canonicalUid(p.userId);
      if (!state.players[uid]) state.players[uid] = {
        niceNames:{}, games:0, wins:0, losses:0, kills:0, deaths:0, assists:0, dmg:0, score:0
      };
      const rec = state.players[uid];
      const name = p.data.niceName || '???';
      // Poids = horodatage de la partie, pas un compteur d'occurrences : latestNiceName()
      // (format.js) doit refléter le pseudo le PLUS RÉCENT vu en jeu, pas le plus fréquent
      // historiquement — un joueur qui change de tag doit être affiché sous son nouveau
      // pseudo dès la partie suivante, pas seulement une fois qu'il a assez rejoué sous ce
      // nouveau tag pour qu'il devienne statistiquement majoritaire.
      const ts = new Date(g.createdAt).getTime();
      if (!rec.niceNames[name] || ts > rec.niceNames[name]) rec.niceNames[name] = ts;
      rec.games++;
      if (p.data.outcome === "Victory") rec.wins++;
      else if (p.data.outcome === "Defeat") rec.losses++;
      rec.kills += p.data.kills || 0;
      rec.deaths += p.data.deaths || 0;
      rec.assists += p.data.assists || 0;
      rec.dmg += p.data.inflictedDamage || 0;
      rec.score += p.data.score || 0;
    });
  });
  // Nom depuis la dernière capture de profil de chaque joueur, en compétition de fraîcheur
  // avec les pseudos vus en jeu ci-dessus — PAS seulement en repli quand le joueur n'a aucune
  // partie. Un joueur qui a rejoué son profil récemment (nouveau displayName/username) mais
  // pas encore de nouvelle partie sous ce nom doit voir son pseudo mis à jour quand même :
  // avant ce correctif, dès qu'un joueur avait ne serait-ce qu'une seule partie connue
  // (même très ancienne), son nom de profil n'était plus jamais consulté, peu importe sa
  // fraîcheur — exactement le bug de pseudo périmé signalé.
  Object.entries(state.playerStatsSnapshots).forEach(([uid, snaps]) => {
    const canon = canonicalUid(uid);
    if (!snaps.length) return;
    if (!state.players[canon]) state.players[canon] = {
      niceNames:{}, games:0, wins:0, losses:0, kills:0, deaths:0, assists:0, dmg:0, score:0
    };
    const last = snaps[snaps.length - 1];
    const name = last.user && (last.user.displayName || last.user.username);
    if (!name) return;
    const rec = state.players[canon];
    const ts = new Date(last.capturedAt).getTime();
    if (!rec.niceNames[name] || ts > rec.niceNames[name]) rec.niceNames[name] = ts;
  });
  // Renommages manuels (voir player-names.js) : appliqués en dernier, après agrégation
  // complète des parties et des snapshots ci-dessus, pour toujours l'emporter.
  applyPlayerNameOverrides(state.players);

  const sorted = Object.entries(state.players).sort((a,b)=>b[1].games-a[1].games);
  if (!state.currentUid || !state.players[state.currentUid]) {
    state.currentUid = sorted.length ? sorted[0][0] : null;
  }
}

// Construit le sélecteur "Joueur" du header : un champ texte filtrable (combobox maison,
// pas de <select> brut) plutôt qu'une liste déroulante native, pour pouvoir retrouver un
// joueur en tapant son pseudo quand il y en a trop pour les parcourir un par un — pensé pour
// un serveur avec beaucoup de comptes suivis. `state.currentUid` reste la seule source de
// vérité (comme avant) ; taper du texte ne fait que FILTRER la liste, il faut cliquer un
// résultat (ou valider avec Entrée) pour changer réellement la sélection.
function playerLabel(uid) {
  const rec = state.players[uid];
  if (!rec) return '';
  return latestNiceName(rec);
}

let pickerHighlightIndex = -1;

export function renderPlayerPicker() {
  const input = document.getElementById('playerPicker');
  input.value = playerLabel(state.currentUid);
  wirePlayerPickerEvents();
}

// Câblé une seule fois (comme les autres boutons statiques de l'app) plutôt qu'à chaque
// rendu — sinon les listeners s'empileraient à chaque appel de renderPlayerPicker().
let pickerWired = false;
function wirePlayerPickerEvents() {
  if (pickerWired) return;
  pickerWired = true;
  const input = document.getElementById('playerPicker');
  const list = document.getElementById('playerPickerList');

  function sortedPlayers() {
    return Object.entries(state.players).sort((a, b) => b[1].games - a[1].games);
  }

  function showList(filterText) {
    const needle = (filterText || '').trim().toLowerCase();
    const matches = sortedPlayers().filter(([, rec]) => latestNiceName(rec).toLowerCase().includes(needle));
    pickerHighlightIndex = -1;
    if (!matches.length) {
      list.innerHTML = '<div class="combobox-empty">Aucun joueur ne correspond.</div>';
    } else {
      list.innerHTML = matches.map(([uid, rec]) => {
        const label = latestNiceName(rec);
        const count = rec.games > 0 ? `${rec.games} parties` : 'profil seul';
        return `<div class="combobox-item${uid === state.currentUid ? ' selected' : ''}" data-uid="${uid}" role="option">
          <span class="name">${label}</span><span class="count">${count}</span>
        </div>`;
      }).join('');
      list.querySelectorAll('.combobox-item[data-uid]').forEach(item => {
        // mousedown (pas click) : se déclenche AVANT le blur de l'input, sinon le blur
        // fermerait la liste en premier et le clic tomberait dans le vide.
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectPlayer(item.dataset.uid);
        });
      });
    }
    list.style.display = 'block';
  }

  function hideList() {
    list.style.display = 'none';
    pickerHighlightIndex = -1;
  }

  function selectPlayer(uid) {
    state.currentUid = uid;
    input.value = playerLabel(uid);
    hideList();
    if (state.profileCompareUid === state.currentUid) state.profileCompareUid = null;
    state.mapDeepDiveSelection = null;
    persistUiPrefs();
    renderSummary();
    renderList();
    document.getElementById('detail').innerHTML =
      '<div class="detail-empty">Sélectionne une partie ou un groupe à gauche pour voir le détail des scores.</div>';
    state.activeGameId = null;
    if (document.getElementById('viewTendances').classList.contains('active')) renderTrends();
    if (document.getElementById('viewProfil').classList.contains('active')) renderProfil();
    if (document.getElementById('viewComparatif').classList.contains('active')) renderComparatif();
  }

  function applyHighlight() {
    const items = list.querySelectorAll('.combobox-item[data-uid]');
    items.forEach((el, i) => el.classList.toggle('highlighted', i === pickerHighlightIndex));
    if (pickerHighlightIndex >= 0 && items[pickerHighlightIndex]) {
      items[pickerHighlightIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  input.addEventListener('focus', () => showList(input.value === playerLabel(state.currentUid) ? '' : input.value));
  input.addEventListener('input', () => showList(input.value));
  input.addEventListener('blur', () => {
    // Délai court : laisse le mousedown d'un item s'exécuter avant que le blur ne referme
    // la liste (voir le commentaire sur .combobox-item ci-dessus).
    setTimeout(() => {
      hideList();
      input.value = playerLabel(state.currentUid); // annule tout texte tapé non confirmé
    }, 150);
  });
  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('.combobox-item[data-uid]');
    if (e.key === 'Escape') {
      input.blur();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.style.display === 'none') { showList(input.value); return; }
      pickerHighlightIndex = Math.min(pickerHighlightIndex + 1, items.length - 1);
      applyHighlight();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      pickerHighlightIndex = Math.max(pickerHighlightIndex - 1, 0);
      applyHighlight();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = pickerHighlightIndex >= 0 ? items[pickerHighlightIndex] : items[0];
      if (target) selectPlayer(target.dataset.uid);
    }
  });
}

// Construit le menu déroulant de filtrage par carte de l'onglet Historique.
export function renderMapFilterOptions() {
  const mapFilter = document.getElementById('mapFilter');
  const current = mapFilter.value;
  mapFilter.innerHTML = '<option value="">Toutes les cartes</option>';
  const mapNames = [...new Set(Object.values(state.gamesById).map(g => g.map && g.map.name).filter(Boolean))].sort();
  mapNames.forEach(m=>{
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    mapFilter.appendChild(opt);
  });
  mapFilter.value = current;
  mapFilter.onchange = renderList;
  document.getElementById('outcomeFilter').onchange = renderList;
}
