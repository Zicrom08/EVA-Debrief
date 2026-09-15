import { state } from './state.js';
import { renderTrends } from './tendances.js';
import { renderProfil } from './profil/index.js';
import { renderComparatif } from './comparatif.js';
import { renderEquipes } from './equipes.js';
import { renderComptes } from './comptes.js';
import { renderImportTokenPanel } from './import-token.js';

// ================= TABS =================
// Logique de bascule partagée entre un clic sur un .tab-btn et un changement d'onglet déclenché
// par le code (ex: showApp() ramène toujours sur "profil", voir shell.js) — un seul chemin pour
// les deux, pour ne jamais les laisser diverger.
export function activateTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
  if (tab === 'tendances') renderTrends();
  if (tab === 'profil') renderProfil();
  if (tab === 'comparatif') renderComparatif();
  if (tab === 'equipes') renderEquipes();
  if (tab === 'comptes') renderComptes();
  if (tab === 'import') renderImportTokenPanel();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

document.getElementById('trendBySession').addEventListener('click', () => setTrendMode('session'));
document.getElementById('trendByMonth').addEventListener('click', () => setTrendMode('month'));
// Bascule l'agrégation de l'onglet Suivi de performance entre "par séance" et "par mois".
export function setTrendMode(mode) {
  state.trendMode = mode;
  document.getElementById('trendBySession').classList.toggle('active', mode === 'session');
  document.getElementById('trendByMonth').classList.toggle('active', mode === 'month');
  renderTrends();
}
