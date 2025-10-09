import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// NOTE: Set base to "/<repo-name>/" after you create the GitHub repo.
export default defineConfig({
  plugins: [svelte()],
  base: '/'
})
