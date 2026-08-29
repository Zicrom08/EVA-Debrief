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

1. Va sur ton instance EVA-Debrief, connecte-toi (rôle `admin` ou `contributor`).
2. Ouvre l'onglet **"+ Importer"** — un bouton **"Lier l'extension EVA-Debrief"**
   apparaît dans la section dédiée si l'extension est bien détectée.
3. Clique dessus. C'est tout : plus rien à configurer.

Ensuite, navigue normalement sur le site EVA (profil, historique) — la capture et
l'envoi se font automatiquement en arrière-plan.

## Diagnostic

- `chrome://extensions` → sur cette extension → **"Inspecter les vues" → service
  worker** ouvre une console dédiée : les échecs de push (jeton révoqué, backend
  injoignable...) y sont journalisés (`[EVA-Debrief] ...`).
- Révoquer/régénérer le jeton depuis EVA-Debrief (onglet "+ Importer") invalide
  immédiatement la liaison — reclique "Lier l'extension" pour la refaire avec un
  nouveau jeton.
