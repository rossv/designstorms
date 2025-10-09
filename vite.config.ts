import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import preprocess from 'svelte-preprocess' 

export default defineConfig({
  plugins: [svelte({ preprocess: preprocess() })],
  base: '/designstorms/',
  server: {
    proxy: {
      // This will proxy requests from /noaa-api/... to the NOAA server
      '/noaa-api': {
        target: 'https://hdsc.nws.noaa.gov',
        changeOrigin: true,
        // Rewrite the path to match the required API endpoint
        rewrite: (path) => path.replace(/^\/noaa-api/, '/cgi-bin/new')
      }
    }
  }
})
