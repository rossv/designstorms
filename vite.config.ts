import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import preprocess from 'svelte-preprocess' 

export default defineConfig({
  plugins: [svelte({ preprocess: preprocess() })],
  base: '/designstorms/',
  server: {
    proxy: {
      '/noaa-api': {
        target: 'https://hdsc.nws.noaa.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/noaa-api/, '/cgi-bin/new')
      }
    }
  }
})
