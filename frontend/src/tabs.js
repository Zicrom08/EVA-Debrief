import { state } from './state.js';
import { renderTrends } from './tendances.js';
import { renderProfil } from './profil/index.js';
import { renderComparatif } from './comparatif.js';
import { renderEquipes } from './equipes.js';
import { renderComptes } from './comptes.js';

// ================= TABS =================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
    if (tab === 'tendances') renderTrends();
    if (tab === 'profil') renderProfil();
    if (tab === 'comparatif') renderComparatif();
    if (tab === 'equipes') renderEquipes();
    if (tab === 'comptes') renderComptes();
  });
});

document.getElementById('trendBySession').addEventListener('click', () => setTrendMode('session'));
document.getElementById('trendByMonth').addEventListener('click', () => setTrendMode('month'));
// Bascule l'agrégation de l'onglet Tendances entre "par séance" et "par mois".
export function setTrendMode(mode) {
  state.trendMode = mode;
  document.getElementById('trendBySession').classList.toggle('active', mode === 'session');
  document.getElementById('trendByMonth').classList.toggle('active', mode === 'month');
  renderTrends();
}
