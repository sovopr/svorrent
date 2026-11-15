import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const backendPort = process.env.VITE_BACKEND_PORT || 3001

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version || '0.0.0'),
  },
  server: {
    proxy: { '/api': `http://127.0.0.1:${backendPort}` },
  },
  preview: {
    proxy: { '/api': `http://127.0.0.1:${backendPort}` },
  },
})
