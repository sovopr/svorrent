import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backendPort = process.env.VITE_BACKEND_PORT || 3001

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': `http://127.0.0.1:${backendPort}` },
  },
  preview: {
    proxy: { '/api': `http://127.0.0.1:${backendPort}` },
  },
})
