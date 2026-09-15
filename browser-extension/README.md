# EVA-Debrief — Collecteur automatique (extension navigateur)

Alternative au userscript (`../eva_history_collector.user.js`) pour Chrome, Edge et
Kiwi Browser (Android) : une fois installée et liée à ton compte EVA-Debrief (un clic,
voir plus bas), elle capture et pousse tes parties/profils automatiquement, sans jamais
avoir à copier-coller une URL ou un jeton à la main.

**Pas pour Firefox desktop, ni iOS** — voir la section "Portée" du README principal
(section "Collecteur de données") pour le détail des raisons. Ces plateformes restent
sur le userscript, qui fonctionne très bien pour elles.

## ⚠️ Domaines ciblés en dur dans `manifest.json`

Contrairement à une première version qui utilisait `<all_urls>` (portée universelle,
mais ambiguë vis-à-vis du réglage runtime "Accès aux sites" — voir Diagnostic
ci-dessous), `manifest.json` liste maintenant **explicitement** les trois domaines
réellement utilisés (`host_permissions` + `content_scripts.matches`) :

- `https://app.eva.gg/*` — le site EVA lui-même (capture).
- `https://zicrom08.github.io/*` — le frontend EVA-Debrief (GitHub Pages).
- `https://zicrom.ddns.net/*` — le backend EVA-Debrief (l'API `/api/import`).

**Si ton déploiement EVA-Debrief vit à une autre adresse** (backend et/ou frontend
différents de ceux-ci), l'extension ne capturera ni ne poussera RIEN tant que tu n'as
pas remplacé ces trois URLs par les tiennes dans `manifest.json` (les deux clés
`host_permissions` et `content_scripts[].matches`, à garder synchronisées) avant de
charger l'extension. Chrome n'affiche alors aucune erreur visible — les content
scripts s'injectent simplement pas sur un domaine non listé, silencieusement.

## Installation (chargement décompressé — pas de store pour l'instant)

1. Télécharge le `.zip` de l'extension — bouton **"⬇️ Télécharger l'extension"** dans le
   panneau "Pont automatique" de l'onglet "+ Importer" sur ton instance EVA-Debrief
   (admin/contributor uniquement), ou directement ce dossier (`browser-extension/`) si tu
   es déjà dans le dépôt. Décompresse-le si tu es parti du `.zip`.
2. Ouvre `chrome://extensions` (ou `edge://extensions`, ou l'équivalent dans Kiwi
   Browser).
3. Active le **"mode développeur"** (bascule en haut à droite sur Chrome/Edge).
4. Clique **"Charger l'extension non empaquetée"**, puis sélectionne le dossier
   `browser-extension/` décompressé.
5. L'extension apparaît dans la liste — rien d'autre à faire ici.

## Liaison à ton compte EVA-Debrief

Deux façons équivalentes de lier l'extension — au choix, elles déclenchent exactement le
même flux :

- **Depuis le popup de l'extension** (icône EVA-Debrief à côté de la barre d'adresse) :
  ouvre l'onglet de ton instance EVA-Debrief (connecté, rôle `admin` ou `contributor`),
  clique l'icône de l'extension, puis **"Lier ce compte EVA-Debrief"**.
- **Depuis la page EVA-Debrief elle-même** : onglet **"+ Importer"** → bouton
  **"Lier l'extension EVA-Debrief"** dans le panneau "Pont automatique" (affiché si
  l'extension est détectée).

Dans les deux cas : un clic, rien à copier-coller. Ensuite, navigue normalement sur le
site EVA (profil, historique) — la capture et l'envoi se font automatiquement en
arrière-plan. Le popup affiche aussi le statut du dernier envoi (parties/profils
ajoutés, ou l'erreur si un push a échoué).

## Diagnostic

- `chrome://extensions` → sur cette extension → **"Inspecter les vues" → service
  worker** ouvre une console dédiée : les échecs de push (jeton révoqué, backend
  injoignable...) y sont journalisés (`[EVA-Debrief] ...`).
- Révoquer/régénérer le jeton depuis EVA-Debrief (onglet "+ Importer") invalide
  immédiatement la liaison — reclique "Lier l'extension" pour la refaire avec un
  nouveau jeton.
- **"Accès aux sites" doit couvrir les 3 domaines listés dans `manifest.json`**
  (`chrome://extensions` → cette extension → **Détails** → "Accès aux sites") — piège
  réel rencontré : avec l'ancienne version en `<all_urls>`, `host_permissions` seul ne
  suffisait **pas** à exempter les envois du CORS normal du web tant que ce réglage
  runtime n'était pas sur **"Sur tous les sites"** — "Sur des sites spécifiques", même
  avec le bon domaine sélectionné, ne suffisait pas non plus (confirmé en pratique).
  Depuis que `manifest.json` déclare des domaines précis plutôt que `<all_urls>`
  (voir plus haut), Chrome accorde normalement l'accès à ces domaines exacts au
  chargement, sans cette ambiguïté — si le popup affiche quand même la bannière rouge
  "Accès aux sites" (ou si la console montre `blocked by CORS policy... preflight
  request`), vérifie ce réglage manuellement et republie-le sur ces 3 domaines si besoin.
- Une version instrumentée (`browser-extension-debug/`, journal détaillé de chaque
  étape) existe pour diagnostiquer un cas qui ne rentre dans aucun des cas ci-dessus —
  voir `browser-extension-debug/README.md`.
