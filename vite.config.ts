import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import preprocess from 'svelte-preprocess' 

export default defineConfig({
  plugins: [svelte({ preprocess: preprocess() })],
  base: '/designstorms/',
  server: {
    proxy: {
      // Proxy requests to the NOAA API
      '/cgi-bin': {
        target: 'https://hdsc.nws.noaa.gov',
        changeOrigin: true,
      }
    }
  }
})
