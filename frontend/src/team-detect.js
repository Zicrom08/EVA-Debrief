import { state } from './state.js';
import { canonicalUid } from './player-links.js';

// ================= DÉTECTION AUTOMATIQUE D'ÉQUIPES PAR PSEUDO =================
// Certains joueurs préfixent leur pseudo EN JEU du tag de leur équipe, sous la forme
// "TAGxPseudo" (ex: "ALPHAxJoueur1", délimiteur "x" minuscule — motif observé dans les
// données réelles de ce projet, exemple ici générique). On ne regarde que le pseudo brut le
// PLUS RÉCENT de chaque joueur (indépendamment d'un éventuel renommage forcé, voir
// player-names.js) : un tag d'équipe reflète l'appartenance ACTUELLE, pas un historique —
// un joueur qui a quitté son ancien tag (ou n'en a jamais eu) ne doit pas y être rattaché
// à tort simplement parce qu'il l'a porté un jour.

// 2-6 caractères alphanumériques pour le tag, puis "x", puis au moins 2 caractères pour le
// reste du pseudo. Ces bornes viennent des tags réellement observés dans les données du
// projet (tous entre 2 et 4 caractères — valeurs exactes non listées ici, ce sont des tags
// d'autres joueurs) — la marge jusqu'à 6 laisse de la place sans être assez large pour
// capturer un faux positif comme un pseudo qui se terminerait par la lettre "x" (le "reste"
// après ce "x" ferait alors 0 caractère, ou le "tag" avant dépasserait 6 caractères : dans
// les deux cas hors bornes).
const TEAM_TAG_RE = /^([A-Za-z0-9]{2,6})x([A-Za-z0-9._-]{2,})$/;

// Nombre minimum de joueurs partageant le même tag pour le retenir comme une vraie équipe
// plutôt qu'une coïncidence dans un pseudo isolé. Sans ce garde-fou, "Boxeur" matcherait
// la regex ci-dessus (tag "Bo" + pseudo "xeur") — un seul joueur avec le tag "Bo" ne
// passe jamais ce seuil, donc jamais proposé comme équipe.
const MIN_TEAM_MEMBERS = 2;

// Pseudo brut le plus récent connu de chaque joueur canonique (voir player-links.js), tel
// que vu en jeu — jamais le nom affiché : un renommage forcé ne doit pas masquer le tag
// d'équipe réellement porté par le pseudo EVA sous-jacent.
function latestRawNicknames() {
  const latest = {}; // uid canonique -> { name, ts }
  Object.values(state.gamesById).forEach(g => {
    const ts = new Date(g.createdAt).getTime();
    (g.players || []).forEach(p => {
      const name = p.data && p.data.niceName;
      if (!name) return;
      const uid = canonicalUid(p.userId);
      if (!latest[uid] || ts > latest[uid].ts) latest[uid] = { name, ts };
    });
  });
  return latest;
}

// Équipes détectées : [{ tag, members: [{ uid, playerName }] }, ...], triées par nombre de
// membres décroissant. `tag` garde la casse du pseudo le plus récemment vu (le regroupement
// lui-même est insensible à la casse, pour ne pas séparer "ALPHAxX" et "alphaxY" en deux
// équipes distinctes si jamais la casse d'un tag varie d'un joueur à l'autre).
export function detectTeamsFromNicknames() {
  const latest = latestRawNicknames();
  const byTag = {}; // tag en minuscule -> { tag, tagTs, members }
  Object.entries(latest).forEach(([uid, { name, ts }]) => {
    const m = TEAM_TAG_RE.exec(name);
    if (!m) return;
    const [, tag, playerName] = m;
    const key = tag.toLowerCase();
    if (!byTag[key]) byTag[key] = { tag, tagTs: ts, members: [] };
    // La casse affichée suit le joueur vu le plus récemment sous ce tag, pas l'ordre de
    // traitement (Object.entries n'a aucune raison d'être trié par date) — sinon une variante
    // de casse du même tag (déjà observée dans les données réelles du projet) afficherait une
    // casse arbitraire selon l'ordre d'itération plutôt que la plus à jour.
    else if (ts > byTag[key].tagTs) { byTag[key].tag = tag; byTag[key].tagTs = ts; }
    byTag[key].members.push({ uid, playerName });
  });
  return Object.values(byTag)
    .map(({ tag, members }) => ({ tag, members }))
    .filter(t => t.members.length >= MIN_TEAM_MEMBERS)
    .sort((a, b) => b.members.length - a.members.length);
}
