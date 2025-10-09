import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import preprocess from 'svelte-preprocess' 

export default defineConfig({
  plugins: [svelte({ preprocess: preprocess() })],
  base: '/designstorms/',
  server: {
    proxy: {
      '/cgi-bin': {
        target: 'https://hdsc.nws.noaa.gov',
        changeOrigin: true,
      }
    }
  }
})
