# EVA-Debrief — Collecteur (DEBUG)

Version de diagnostic de [`browser-extension/`](../browser-extension/), à utiliser
**temporairement** chez un utilisateur qui rencontre un problème que les indications de
diagnostic du [README de la version normale](../browser-extension/README.md) ne
suffisent pas à identifier. Logique strictement identique à la version normale — ce qui
change, c'est un journal détaillé (`console.log`/`console.info`/`console.warn`/
`console.error`, préfixés `[EVA-Debrief DEBUG]`) à chaque étape : capture, relais entre
les deux mondes du content script, configuration lue, permission runtime vérifiée, URL
exacte appelée, statut/en-têtes/corps de la réponse HTTP, erreur complète en cas
d'échec.

**Avant de sortir cet outil : vérifie d'abord le cas déjà identifié et corrigé** — voir
la section "Accès aux sites" du [README de la version normale](../browser-extension/README.md#diagnostic).
La version normale affiche maintenant une bannière dédiée dans son popup si c'est ça.
Cette version debug sert pour un cas qui ne rentre dans AUCUN des cas déjà connus.

## Installation

**Ne charge jamais les deux extensions (normale + debug) en même temps sur le même
profil Chrome** : les deux hooks `fetch`/`XMLHttpRequest` de `content-main-world.js`
s'installeraient l'un par-dessus l'autre, rendant le diagnostic incohérent (double
capture, logs mélangés). Désactive (pas besoin de désinstaller) l'extension normale
d'abord (`chrome://extensions` → bascule "Activé").

1. `chrome://extensions` → mode développeur activé → "Charger l'extension non
   empaquetée" → sélectionne ce dossier (`browser-extension-debug/`).
2. Reconfigure la liaison depuis le popup de CETTE extension (icône "EVA-Debrief
   (DEBUG)") — la configuration (`backendUrl`/`importToken`) n'est PAS partagée entre
   les deux extensions (`chrome.storage.local` est isolé par extension).

## Où regarder

Trois consoles différentes, pour isoler à quel maillon de la chaîne ça casse :

1. **Console de la page EVA** (F12 sur le site EVA lui-même) : logs de
   `content-main-world.js` (capture) — confirme que la capture réseau fonctionne
   toujours (déjà confirmé dans le cas qui a motivé cet outil, mais vérifie qu'aucune
   régression n'est apparue) et que le `CustomEvent` est bien dispatché.
2. **Console de la page EVA également** (`content-isolated.js` y tourne aussi, en
   monde ISOLATED mais toujours rattachée aux devtools de CETTE page) : confirme que
   le relais `chrome.runtime.sendMessage` part bien, et si `chrome.runtime.lastError`
   est levée (service worker inactif/rechargé — signe possible en soi).
3. **Console du service worker** (`chrome://extensions` → cette extension →
   "Inspecter les vues" → service worker) : logs de `background.js` — configuration
   lue (jeton masqué), **vérification `chrome.permissions.contains()`** (voir
   ci-dessous), URL exacte appelée, statut HTTP et corps complet de la réponse, ou
   l'erreur JS complète (`name`/`message`/`stack`) en cas d'échec réseau.

Le popup (F12 sur le popup lui-même, clic droit → Inspecter) journalise aussi le
contenu complet de `chrome.storage.local` à chaque ouverture.

## Ce qu'il faut me renvoyer

Copie les logs des **trois consoles ci-dessus** (le plus simple : capture une partie,
puis colle tout ce qui est apparu dans chacune) — en particulier :
- Le résultat de la vérification `chrome.permissions.contains()` dans la console du
  service worker (`✅ accordée` ou `⚠️ PERMISSION RUNTIME NON ACCORDÉE`).
- Le statut HTTP et le corps de la réponse si une requête part effectivement.
- Le nom et le message exacts de l'exception si le `fetch()` échoue avant même
  d'obtenir une réponse (`TypeError: Failed to fetch` = signe quasi certain d'un
  blocage réseau/CORS/certificat, pas un problème côté EVA-Debrief lui-même).

## Fichiers concernés

Miroir exact de `browser-extension/` (mêmes fichiers, mêmes noms) — toute correction de
LOGIQUE (pas juste un ajout de log) découverte via cet outil doit être reportée dans
`browser-extension/` (la version de prod), jamais laissée seulement ici.
