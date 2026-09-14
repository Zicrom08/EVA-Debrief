# EVA-Debrief — Collecteur automatique (extension navigateur)

Alternative au userscript (`../eva_history_collector.user.js`) pour Chrome, Edge et
Kiwi Browser (Android) : une fois installée et liée à ton compte EVA-Debrief (un clic,
voir plus bas), elle capture et pousse tes parties/profils automatiquement, sans jamais
avoir à copier-coller une URL ou un jeton à la main.

**Pas pour Firefox desktop, ni iOS** — voir la section "Portée" du README principal
(section "Collecteur de données") pour le détail des raisons. Ces plateformes restent
sur le userscript, qui fonctionne très bien pour elles.

## Installation (chargement décompressé — pas de store pour l'instant)

1. Ouvre `chrome://extensions` (ou `edge://extensions`, ou l'équivalent dans Kiwi
   Browser).
2. Active le **"mode développeur"** (bascule en haut à droite sur Chrome/Edge).
3. Clique **"Charger l'extension non empaquetée"**, puis sélectionne ce dossier
   (`browser-extension/`).
4. L'extension apparaît dans la liste — rien d'autre à faire ici.

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
- **"Accès aux sites" doit être sur "Sur tous les sites"** — piège réel rencontré :
  `host_permissions: ["<all_urls>"]` dans `manifest.json` ne suffit **pas** à lui seul
  à exempter les envois du CORS normal du web. Si le réglage **"Accès aux sites"**
  (`chrome://extensions` → cette extension → **Détails**) est sur "Sur clic" ou "Sur
  des sites spécifiques" au lieu de **"Sur tous les sites"**, chaque envoi échoue
  silencieusement par CORS (`blocked by CORS policy... preflight request`), visible
  uniquement dans la console du service worker, jamais dans le popup — sauf depuis la
  correction qui ajoute une bannière dédiée dans le popup avec un bouton pour corriger
  ce réglage en un clic. Si le popup affiche cette bannière (ou si la console montre
  cette erreur CORS précise), c'est la cause : passe "Accès aux sites" sur "Sur tous
  les sites" et réessaie. **"Sur des sites spécifiques" avec le bon domaine sélectionné
  ne suffit PAS non plus** (confirmé en pratique) — seul "Sur tous les sites" fonctionne
  de façon fiable, même si le domaine du backend est déjà correctement listé dans les
  sites spécifiques.
- Une version instrumentée (`browser-extension-debug/`, journal détaillé de chaque
  étape) existe pour diagnostiquer un cas qui ne rentre dans aucun des cas ci-dessus —
  voir `browser-extension-debug/README.md`.
