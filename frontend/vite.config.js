import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
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
