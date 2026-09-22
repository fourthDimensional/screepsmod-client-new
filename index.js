'use strict'

const path = require('node:path')
const fs = require('node:fs')
const express = require('express')
const pkg = require('./package.json')

function readBool(envName, modValue, fallback) {
  const env = process.env[envName]
  if (env !== undefined) {
    const v = env.toLowerCase()
    return v === '1' || v === 'true' || v === 'yes'
  }
  if (modValue !== undefined) return Boolean(modValue)
  return fallback
}

function readString(envName, modValue, fallback) {
  return process.env[envName] ?? modValue ?? fallback
}

// Vite content-hashes everything under the assets dir (_client/), so those URLs
// change whenever their content does and can be cached forever. Everything else
// (index.html, themes/, other public/ assets) keeps a stable URL across releases
// and must be revalidated so updated files (e.g. the sprite atlas) aren't served
// stale from the browser cache.
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
const REVALIDATE_CACHE = 'no-cache'

function isHashedAsset(filePath) {
  return filePath.includes(`${path.sep}_client${path.sep}`)
}

function setStaticCacheHeaders(res, filePath) {
  res.setHeader('Cache-Control', isHashedAsset(filePath) ? IMMUTABLE_CACHE : REVALIDATE_CACHE)
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

// The client fetches `/api/version` on load (pre-login and again post-connect) to
// configure itself: welcome text, shards, history settings, and the auth/feature
// gates. Since the server already has this on hand when it renders index.html, we
// prefetch it once in-process and inline it as `window.__SCREEPS_BOOTSTRAP__`, so
// the embedded client is configured from the first frame with zero round-trips.
// Cached like the client's own 5-min version cache; failures just omit the global
// and the client falls back to its normal fetch.
const VERSION_TTL_MS = 5 * 60_000
let versionCache = null

async function bootstrapVersion(req) {
  const now = Date.now()
  if (versionCache && now < versionCache.expires) return versionCache.data
  try {
    const origin = `${req.protocol}://${req.get('host')}`
    const res = await fetch(`${origin}/api/version`)
    if (!res.ok) return null
    const data = await res.json()
    versionCache = { data, expires: now + VERSION_TTL_MS }
    return data
  } catch (err) {
    console.error('[screeps-mod-client] failed to prefetch /api/version for bootstrap:', err)
    return null
  }
}

function renderInjectedIndex(indexFile, version) {
  const metadata = jsonForScript({
    kind: 'screeps-mod',
    packageName: pkg.name,
    version: pkg.version,
  })
  const bootstrap = version ? `;window.__SCREEPS_BOOTSTRAP__=${jsonForScript(version)}` : ''
  const script = `<script>window.__SCREEPS_CLIENT_EMBEDDED__=${metadata}${bootstrap}</script>`
  const html = fs.readFileSync(indexFile, 'utf8')
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : script + html
}

module.exports = function (config) {
  if (!config.backend) return

  const modCfg = (config.common && config.common.modConfig && config.common.modConfig.client) || {}

  let mountPath = readString('SCREEPS_MOD_CLIENT_MOUNT_PATH', modCfg.mountPath, '/client')
  if (!mountPath.startsWith('/')) mountPath = '/' + mountPath
  mountPath = mountPath.replace(/\/+$/, '') || '/'

  const rootRedirect = readBool('SCREEPS_MOD_CLIENT_ROOT_REDIRECT', modCfg.rootRedirect, true)
  // Vendored in-tree (./dist/embedded) rather than resolved from a "screeps-client" npm
  // dependency: this fork carries a RoomStore fix (also subscribe the unprefixed
  // `room:<room>` channel) that private servers need but the upstream package doesn't have.
  const distDir = path.join(__dirname, 'dist', 'embedded')

  const indexFile = path.join(distDir, 'index.html')

  // Optional signup gate. When SCREEPS_CLUB_PASSWORD is set, /api/register/submit
  // requires a matching `clubPassword` field in the JSON body; the embedded client
  // asks for it on the registration form. Unset means open registration
  // (screepsmod-auth's normal behaviour).
  const clubPassword = process.env.SCREEPS_CLUB_PASSWORD

  async function sendInjectedIndex(req, res) {
    const version = await bootstrapVersion(req)
    res.setHeader('Cache-Control', REVALIDATE_CACHE)
    res.type('html').send(renderInjectedIndex(indexFile, version))
  }

  config.backend.on('expressPreConfig', (app) => {
    if (clubPassword) {
      // Registered before the screepsmod-auth router (this mod must load first in
      // mods.json), so an invalid club password never reaches the register handler.
      // Returns 200 + { error } so the client form can display it, matching the
      // shape screepsmod-auth uses for its own registration errors.
      app.use('/api/register/submit', express.json(), (req, res, next) => {
        if (req.method !== 'POST') return next()
        const supplied = req.body && req.body.clubPassword
        if (typeof supplied !== 'string' || supplied !== clubPassword) {
          res.status(200).json({ ok: 0, error: 'Invalid club password' })
          return
        }
        next()
      })
    }

    const indexRoutes = mountPath === '/' ? ['/', '/index.html'] : [mountPath, mountPath + '/', mountPath + '/index.html']

    app.get(indexRoutes, (req, res) => {
      void sendInjectedIndex(req, res)
    })

    app.use(mountPath, express.static(distDir, { fallthrough: true, index: false, setHeaders: setStaticCacheHeaders }))

    if (rootRedirect && mountPath !== '/') {
      const alreadyRegistered = app._router?.stack?.some(
        layer => layer.route?.path === '/' && layer.route?.methods?.get
      )
      if (alreadyRegistered) {
        console.warn(`[screeps-mod-client] WARNING: GET / is already registered by another mod — redirect to ${mountPath}/ will not take effect. Move screeps-mod-client before other mods in mods.json to ensure priority.`)
      }
      app.get('/', (_req, res) => {
        res.redirect(302, mountPath + '/')
      })
    }
  })

  // SPA fallback registered in expressPostConfig so backend routes (e.g. /room-history,
  // /api/...) are matched first and never shadowed by the catch-all.
  config.backend.on('expressPostConfig', (app) => {
    app.use(mountPath, (req, res, next) => {
      if (req.method !== 'GET') return next()
      void sendInjectedIndex(req, res)
    })
  })

  console.log(`[screeps-mod-client] serving client at ${mountPath}/ (rootRedirect=${rootRedirect})`)
}
