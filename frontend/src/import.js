import { state } from './state.js';
import { apiSend, loadFromServer } from './api.js';
import { persistUiPrefs } from './ui-prefs.js';
import { ensureModeDefaults } from './game-filters.js';
import { rebuildPlayerIndex } from './player-index.js';
import { showApp } from './shell.js';

// ================= IMPORT =================
// Toute la logique de fusion / déduplication / filtrage PvE vit maintenant côté serveur
// (voir backend/server.js) — le navigateur se contente de poster le JSON tel quel et de recharger
// l'état complet ensuite via loadFromServer(). C'est plus robuste : la déduplication est
// garantie même si on importe depuis plusieurs navigateurs/appareils différents.

// Parse un texte JSON collé/déposé et l'envoie au serveur pour import — la déduplication et le filtrage PvE sont entièrement gérés côté serveur (voir backend/server.js).
async function tryLoadJSON(text, sourceLabel) {
  const errEl = document.getElementById('importError');
  errEl.textContent = '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    errEl.style.color = 'var(--loss)';
    errEl.textContent = `Impossible de lire "${sourceLabel}" : JSON invalide.`;
    return false;
  }

  errEl.style.color = 'var(--muted)';
  errEl.textContent = `Import de "${sourceLabel}" en cours…`;

  try {
    const result = await apiSend('POST', '/api/import', parsed);
    if (!result.recognized) {
      errEl.style.color = 'var(--loss)';
      errEl.textContent = `Format non reconnu dans "${sourceLabel}".`;
      return false;
    }
    const parts = [];
    if (result.addedGames) parts.push(`+${result.addedGames} nouvelle(s) partie(s)`);
    if (result.updatedGames) parts.push(`${result.updatedGames} déjà connue(s) mise(s) à jour`);
    if (result.skippedPve) parts.push(`${result.skippedPve} partie(s) PvE ignorée(s)`);
    if (result.addedStats) parts.push(`+${result.addedStats} profil(s) capturé(s)`);
    if (result.duplicateStats) parts.push(`${result.duplicateStats} profil(s) déjà identique(s) ignoré(s)`);
    const gotSomethingNew = result.addedGames || result.addedStats;
    errEl.style.color = gotSomethingNew ? 'var(--win)' : 'var(--gold)';
    errEl.textContent = parts.length
      ? `"${sourceLabel}" : ${parts.join(' · ')}.`
      : `"${sourceLabel}" ne contenait rien de nouveau à ajouter (déjà importé).`;
    return true;
  } catch (e) {
    errEl.style.color = 'var(--loss)';
    errEl.textContent = `Erreur serveur pendant l'import de "${sourceLabel}" (${e.message}). Vérifie que le serveur tourne bien.`;
    return false;
  }
}

// Recharge l'état complet depuis le serveur après un ou plusieurs imports et rafraîchit l'interface.
async function finalizeImport() {
  try {
    await loadFromServer();
  } catch (e) {
    const errEl = document.getElementById('importError');
    errEl.style.color = 'var(--loss)';
    errEl.textContent = `Impossible de recharger les données depuis le serveur (${e.message}).`;
    return;
  }
  if (Object.keys(state.gamesById).length === 0 && Object.keys(state.playerStatsSnapshots).length === 0) return;
  ensureModeDefaults();
  rebuildPlayerIndex();
  persistUiPrefs();
  showApp();
}

// Lit un fichier sélectionné/déposé sous forme de texte (Promise autour de FileReader).
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('lecture impossible'));
    reader.readAsText(file);
  });
}

// Importe un ou plusieurs fichiers JSON séquentiellement, puis rafraîchit l'app une fois tous traités.
async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  for (const file of files) {
    try {
      const text = await readFileAsText(file);
      await tryLoadJSON(text, file.name);
    } catch (e) {
      const errEl = document.getElementById('importError');
      errEl.style.color = 'var(--loss)';
      errEl.textContent = `Erreur de lecture pour "${file.name}".`;
    }
  }
  await finalizeImport();
}

// ================= IMPORT SCREEN WIRING =================
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

['dragenter','dragover'].forEach(evt => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.add('dragover');
  });
});
['dragleave','drop'].forEach(evt => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

document.getElementById('loadPasteBtn').addEventListener('click', async () => {
  const text = document.getElementById('pasteArea').value.trim();
  if (!text) {
    document.getElementById('importError').style.color = 'var(--loss)';
    document.getElementById('importError').textContent = 'Colle du JSON avant de charger.';
    return;
  }
  const ok = await tryLoadJSON(text, 'texte collé');
  if (ok) {
    document.getElementById('pasteArea').value = '';
    await finalizeImport();
  }
});
