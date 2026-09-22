'use strict'

const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
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

function readInt(envName, fallback) {
  const value = parseInt(process.env[envName], 10)
  return Number.isFinite(value) ? value : fallback
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

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── client address ────────────────────────────────────────────────────────────
//
// The origin port is published publicly, so forwarding headers can be spoofed by
// anyone connecting directly. They are only trusted when the immediate TCP peer is
// loopback (the host's cloudflared/tunnel or a host reverse proxy) or one of
// Cloudflare's published edge ranges. HTTP/3 and tunneled requests then keep their
// per-client identity; direct connections are keyed on their socket address.

const CF_IPV4_URL = 'https://www.cloudflare.com/ips-v4'
let cfRanges = []

function refreshCloudflareRanges() {
  fetch(CF_IPV4_URL)
    .then((res) => (res.ok ? res.text() : null))
    .then((text) => {
      if (text) cfRanges = text.split(/\s+/).filter(Boolean)
    })
    .catch(() => { /* keep the previous list */ })
}

refreshCloudflareRanges()
setInterval(refreshCloudflareRanges, 24 * 60 * 60 * 1000).unref?.()

function normalizeIp(ip) {
  return ip && ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

function ipv4ToInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = (value << 8) | octet
  }
  return value >>> 0
}

function ipv4InCidr(ip, cidr) {
  const [range, bitsRaw] = cidr.split('/')
  const bits = parseInt(bitsRaw, 10)
  const ipInt = ipv4ToInt(ip)
  const rangeInt = ipv4ToInt(range)
  if (ipInt === null || rangeInt === null || !Number.isInteger(bits)) return false
  if (bits <= 0) return true
  if (bits > 32) return false
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (ipInt & mask) === (rangeInt & mask)
}

function isTrustedProxyPeer(ip) {
  const normalized = normalizeIp(ip)
  if (!normalized) return false
  if (normalized === '127.0.0.1' || normalized === '::1') return true
  if (normalized.includes(':')) return false
  return cfRanges.some((cidr) => ipv4InCidr(normalized, cidr))
}

function clientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || ''
  if (!isTrustedProxyPeer(peer)) return peer || 'unknown'
  const cfIp = req.get && req.get('cf-connecting-ip')
  if (cfIp && cfIp.trim()) return cfIp.trim()
  const forwarded = (req.get && req.get('x-forwarded-for')) || ''
  const first = forwarded.split(',')[0].trim()
  return first || peer || 'unknown'
}

// ── rate limiting ─────────────────────────────────────────────────────────────

const rateLimitsDisabled = readBool('SCREEPS_RATE_LIMIT_DISABLED', undefined, false)

function createRateLimiter({ name, windowMs, max }) {
  const hits = new Map()
  return function rateLimit(req, res, next) {
    if (rateLimitsDisabled || max <= 0) return next()
    const now = Date.now()
    if (hits.size > 5000) {
      for (const [key, entry] of hits) {
        if (entry.reset <= now) hits.delete(key)
      }
    }
    const key = `${name}:${clientIp(req)}`
    const entry = hits.get(key)
    if (!entry || entry.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs })
      return next()
    }
    entry.count += 1
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.reset - now) / 1000))))
      res.status(429).json({ ok: 0, error: 'Too many requests, try again later' })
      return
    }
    next()
  }
}

// ── security headers ──────────────────────────────────────────────────────────

const HSTS = 'max-age=31536000; includeSubDomains'

function securityHeaders(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64')
  res.locals.cspNonce = nonce
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://s3.amazonaws.com https://www.leagueofautomatednations.com",
    "connect-src 'self' https://s3.amazonaws.com https://www.leagueofautomatednations.com",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site')
  res.setHeader('X-Robots-Tag', 'noindex')
  if (req.get('x-forwarded-proto') === 'https' || req.secure) {
    res.setHeader('Strict-Transport-Security', HSTS)
  }
  next()
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const aBytes = Buffer.from(a, 'utf8')
  const bBytes = Buffer.from(b, 'utf8')
  if (aBytes.length !== bBytes.length) return false
  return crypto.timingSafeEqual(aBytes, bBytes)
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

function renderInjectedIndex(indexFile, version, nonce, title) {
  const metadata = jsonForScript({
    kind: 'screeps-mod',
    packageName: pkg.name,
    version: pkg.version,
  })
  const bootstrap = version ? `;window.__SCREEPS_BOOTSTRAP__=${jsonForScript(version)}` : ''
  const script = `<script nonce="${nonce}">window.__SCREEPS_CLIENT_EMBEDDED__=${metadata}${bootstrap}</script>`
  let html = fs.readFileSync(indexFile, 'utf8')
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : script + html
}

module.exports = function (config) {
  if (!config.backend) return

  const modCfg = (config.common && config.common.modConfig && config.common.modConfig.client) || {}

  let mountPath = readString('SCREEPS_MOD_CLIENT_MOUNT_PATH', modCfg.mountPath, '/client')
  if (!mountPath.startsWith('/')) mountPath = '/' + mountPath
  mountPath = mountPath.replace(/\/+$/, '') || '/'

  const rootRedirect = readBool('SCREEPS_MOD_CLIENT_ROOT_REDIRECT', modCfg.rootRedirect, true)
  const clientTitle = readString('SCREEPS_CLIENT_TITLE', modCfg.title, 'Alknost.space')
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

  const registerLimiter = createRateLimiter({
    name: 'register',
    windowMs: 15 * 60_000,
    max: readInt('SCREEPS_RATE_LIMIT_REGISTER_MAX', 5),
  })
  const signinLimiter = createRateLimiter({
    name: 'signin',
    windowMs: 15 * 60_000,
    max: readInt('SCREEPS_RATE_LIMIT_SIGNIN_MAX', 20),
  })
  const checkLimiter = createRateLimiter({
    name: 'check',
    windowMs: 60_000,
    max: readInt('SCREEPS_RATE_LIMIT_CHECK_MAX', 60),
  })

  async function sendInjectedIndex(req, res) {
    const version = await bootstrapVersion(req)
    res.setHeader('Cache-Control', REVALIDATE_CACHE)
    res.type('html').send(renderInjectedIndex(indexFile, version, res.locals.cspNonce, clientTitle))
  }

  config.backend.on('expressPreConfig', (app) => {
    app.disable('x-powered-by')
    app.use(securityHeaders)

    app.use('/api/register/check-username', checkLimiter)
    app.use('/api/register/check-email', checkLimiter)
    app.use('/api/auth/signin', signinLimiter)
    app.use('/api/register/submit', registerLimiter)

    if (clubPassword) {
      // Registered before the screepsmod-auth router (this mod must load first in
      // mods.json), so an invalid club password never reaches the register handler.
      // Returns 200 + { error } so the client form can display it, matching the
      // shape screepsmod-auth uses for its own registration errors. The comparison is
      // constant-time to avoid leaking the password through response timing.
      app.use('/api/register/submit', express.json(), (req, res, next) => {
        if (req.method !== 'POST') return next()
        const supplied = req.body && req.body.clubPassword
        if (!safeEqual(supplied, clubPassword)) {
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

  console.log(`[screeps-mod-client] serving client at ${mountPath}/ (rootRedirect=${rootRedirect}, title=${clientTitle})`)
}