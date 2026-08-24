import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // '/' par défaut (déploiement même-origine, servi à la racine par backend/server.js —
  // comportement inchangé). Un site de PROJET GitHub Pages (pas un domaine perso) est servi
  // sous /<repo>/, pas à la racine : la GitHub Action passe VITE_BASE_PATH=/EVA-Debrief/
  // pour ce build précis (voir .github/workflows/deploy-gh-pages.yml). Même mécanisme que
  // VITE_PORT/PORT juste en dessous.
  base: process.env.VITE_BASE_PATH || '/',
  build: {
    outDir: 'dist',
    // rolldownOptions (pas rollupOptions) depuis Vite 8 : Rolldown remplace Rollup comme
    // bundler de prod (voir la migration v8, GHSA-fx2h-pf6j-xcff corrigée par ce bump).
    rolldownOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
      },
    },
  },
  server: {
    // Configurable pour pouvoir lancer une deuxième instance de dev en parallèle
    // (ex: PORT=3001 VITE_PORT=5174 npm run dev) sans modifier ce fichier —
    // PORT est la même variable que lit backend/server.js, réutilisée ici pour
    // que le proxy pointe automatiquement vers le bon backend.
    port: Number(process.env.VITE_PORT) || 5173,
    proxy: {
      '/api': { target: `http://localhost:${process.env.PORT || 3000}`, changeOrigin: true },
    },
  },
});
