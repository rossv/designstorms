import App from './App.svelte'
import 'leaflet/dist/leaflet.css'
import './theme.css'
import faviconUrl from './design_storm.ico?url'

function ensureFavicon() {
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']")
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  if (link.href !== faviconUrl) {
    link.href = faviconUrl
  }
}

ensureFavicon()

const app = new App({ target: document.getElementById('app')! })
export default app
