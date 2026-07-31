import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/fixture/',
  plugins: [
    VitePWA({
      manifest: {
        name: 'fixture — minuteur de focus',
        short_name: 'fixture',
        description: 'Un minuteur de focus local-first : sessions, tâches et statistiques.',
        lang: 'fr',
        start_url: '/fixture/',
        theme_color: '#0b0f0e',
        categories: ['productivity'],
      },
      workbox: { cacheId: 'fixture-v1' },
    }),
  ],
})
