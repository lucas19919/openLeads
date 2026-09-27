import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, /api is proxied to the local API so cookies are same-origin
// (no CORS). In prod the API serves this build, so /api is already same-origin.
// Set API_URL to point the dev server at an API on another port — useful when
// the default one is occupied (e.g. a container already bound to 8787).
export default defineConfig({
  // Relative asset paths: the same build works at / and under a path (werkbank
  // shows the app at /apps/kunden/).
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.API_URL ?? 'http://127.0.0.1:8787',
    },
  },
})
