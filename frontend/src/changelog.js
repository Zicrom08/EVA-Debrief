// ================= CHANGELOG (infobulle du header, bouton #changelogBtn) =================
// Liste condensée tenue À LA MAIN, la plus récente en premier — un résumé côté UTILISATEUR
// de ce qui a changé, pas un miroir de l'historique git (dépendances, CI, refactors internes,
// corrections de bugs internes à l'extension navigateur... n'y ont pas leur place). Mettre à
// jour cette liste après chaque changement notable pour quelqu'un qui UTILISE l'app.
export const CHANGELOG = [
  { date: '2026-09-15', items: [
    "Le delta de dégâts du tableau d'évolution (Profil) est recalculé depuis l'historique de parties quand EVA ne le fournit plus.",
    "Nouveau filtre « Composition » dans l'Historique : ne montre que les parties avec les coéquipiers/adversaires choisis.",
    "Bouton « Joueur par défaut » à côté de la barre de recherche de joueur : présélectionné automatiquement à la connexion.",
    "Le joueur sélectionné n'est plus perdu au rafraîchissement de la page — seulement remis à zéro à une vraie connexion.",
  ]},
  { date: '2026-09-14', items: [
    "Détection automatique d'équipe corrigée : un joueur qui change d'équipe est bien retiré de l'ancienne, pas seulement ajouté à la nouvelle.",
    "Précision moyenne ajoutée au bandeau de résumé et aux meilleures performances du Profil.",
    "Classement MVP de la partie ajouté au Profil, à côté du classement MVP par équipe.",
    "Sélecteur « Joueur » du header : recherche par pseudo au lieu d'une liste déroulante classique.",
    "Groupes de parties privés (training/scrim) dans l'Historique, avec récap agrégé par joueur.",
    "Retrait du captcha Cloudflare sur l'inscription publique.",
  ]},
];

function renderChangelogTooltip() {
  const el = document.getElementById('changelogTooltip');
  if (!el) return;
  el.innerHTML = `
    <div class="changelog-title">Dernières nouveautés</div>
    ${CHANGELOG.map(group => `
      <div class="changelog-group">
        <div class="changelog-date">${new Date(group.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })}</div>
        <ul>${group.items.map(text => `<li>${text}</li>`).join('')}</ul>
      </div>
    `).join('')}
  `;
}

function closeChangelogTooltip() {
  const el = document.getElementById('changelogTooltip');
  const btn = document.getElementById('changelogBtn');
  if (el) el.style.display = 'none';
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// Câblé une seule fois au chargement du module (les éléments existent déjà dans le DOM,
// seul leur conteneur #headerActions reste display:none tant que personne n'est connecté —
// même principe que les autres boutons statiques du header, voir historique.js).
document.getElementById('changelogBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const el = document.getElementById('changelogTooltip');
  const btn = document.getElementById('changelogBtn');
  const opening = el.style.display === 'none';
  if (opening) renderChangelogTooltip();
  el.style.display = opening ? 'block' : 'none';
  btn.setAttribute('aria-expanded', String(opening));
});
// Clic en dehors de l'infobulle (ou de son bouton) : la referme, comme un vrai tooltip
// plutôt qu'un panneau qu'il faudrait refermer explicitement.
document.addEventListener('click', (e) => {
  const wrap = document.querySelector('.changelog-wrap');
  if (wrap && !wrap.contains(e.target)) closeChangelogTooltip();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeChangelogTooltip();
});
