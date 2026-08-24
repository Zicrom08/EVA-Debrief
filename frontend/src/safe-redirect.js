// N'accepte un chemin de redirection post-connexion (le paramètre `next` de l'URL de
// login.html, voir login.js) que s'il s'agit d'un chemin RELATIF vers CE site — jamais une
// URL absolue ni un schéma dangereux. `next` vient de l'URL, donc entièrement contrôlé par
// quiconque envoie le lien : sans ce filtre, "login.html?next=https://site-malveillant.example"
// redirigerait un utilisateur fraîchement connecté vers un autre site (open redirect), et
// "login.html?next=javascript:...", assigné tel quel à location.href, EXÉCUTERAIT ce code
// dans le contexte de la page (XSS DOM) — les deux détectés par CodeQL sur cette assignation.
// "//exemple.com" (protocole-relatif) et tout chemin contenant un "\" (certains navigateurs le
// traitent comme un "/", contournement connu d'un simple startsWith('/')) sont donc exclus.
export function safeNextPath(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.includes('\\')) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}
