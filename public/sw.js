const CACHE_NAME = 'freecut-shell-v1'
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/pwa-icon.svg', '/pwa-icon-192.png', '/pwa-icon-512.png']
const ASSET_PATTERN = /\.(?:css|ico|js|png|svg|webmanifest|webp|woff2?)$/i

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    const response = await fetch('/index.html')
    if (!response.ok) throw new Error(`No se pudo precargar la app (${response.status}).`)
    const html = await response.text()
    await cache.put('/index.html', new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }))
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:css|js))["']/gi)]
      .map((match) => match[1])
      .filter((path) => path.startsWith('/') && !path.startsWith('//'))
    await cache.addAll([...new Set([...APP_SHELL, ...assets])])
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys()
    await Promise.all(cacheNames
      .filter((name) => name.startsWith('freecut-shell-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    request.headers.has('range') ||
    url.origin !== self.location.origin
  ) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const cached = await caches.match('/index.html')
      if (!cached) throw new Error('No hay una copia local de la aplicación.')
      return cached
    }))
    return
  }

  if (ASSET_PATTERN.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME)
        await cache.put(request, response.clone())
      }
      return response
    })())
  }
})
