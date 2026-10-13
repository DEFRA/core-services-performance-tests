#!/usr/bin/env node
/**
 * Generate a CW session cookie via direct HTTP OAuth flow — no browser, no CDN required.
 *
 * The Microsoft login form requires aadcdn.msauth.net which is blocked by the CDP squid
 * proxy. This script replicates the OAuth flow using raw HTTP requests, which only need
 * access to login.microsoftonline.com (allowed) and the CW frontend (internal).
 *
 * Flow:
 *   1. GET CW root → 302 to Microsoft OAuth URL (capture CW pre-auth cookie)
 *   2. GET Microsoft auth URL → parse $Config (urlPost, sFT, sCtx)
 *   3. POST username → get password page → parse new $Config
 *   4. POST password → follow redirect chain
 *   5. Optionally handle "Stay signed in?" (KMSI)
 *   6. Microsoft redirects to CW /login/callback?code=… → CW sets session cookie
 *   7. Append "session=<value>" to OUTPUT_FILE CSV
 *
 * Env vars:
 *   CW_FRONTEND_URL          required
 *   ENTRA_ID_WRITER_USER     required
 *   ENTRA_ID_USER_PASSWORD   required
 *   OUTPUT_FILE              optional (default /app/src/data/frps-session-cookies.csv)
 *   HTTPS_PROXY / HTTP_PROXY optional — auto-used in CDP (set by entrypoint.sh)
 *   LOCAL                    set to 'true' to skip proxy (local dev)
 */

import { ProxyAgent, fetch as undiciF } from 'undici'
import fs from 'node:fs/promises'
import path from 'node:path'
import { URL } from 'node:url'

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

const isLocal = process.env.LOCAL === 'true'
const rawProxyUrl = isLocal ? null : (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null)

// undici ProxyAgent connects to the proxy over plain HTTP (CONNECT tunnel).
// If the env var uses https:// scheme, replace it with http:// so undici can
// establish the TCP connection to the proxy.
const proxyUrl = rawProxyUrl ? rawProxyUrl.replace(/^https:\/\//, 'http://') : null

let dispatcher
if (proxyUrl) {
  dispatcher = new ProxyAgent({ uri: proxyUrl })
  console.log(`[http-auth] Proxy: ${proxyUrl.replace(/:([^@]+)@/, ':***@')}`)
} else {
  console.log('[http-auth] No proxy (direct connection)')
}

// ---------------------------------------------------------------------------
// Cookie jar (per-hostname, simple Map)
// ---------------------------------------------------------------------------

const jar = new Map() // hostname -> Map<name, value>

function storeCookies(urlStr, headers) {
  const hostname = new URL(urlStr).hostname
  if (!jar.has(hostname)) jar.set(hostname, new Map())
  const hostJar = jar.get(hostname)

  let setCookieValues = []
  if (typeof headers.getSetCookie === 'function') {
    setCookieValues = headers.getSetCookie()
  } else {
    for (const [key, val] of headers.entries()) {
      if (key.toLowerCase() === 'set-cookie') setCookieValues.push(val)
    }
  }

  for (const header of setCookieValues) {
    const [nameVal] = header.split(';')
    const eq = nameVal.indexOf('=')
    if (eq === -1) continue
    const name = nameVal.substring(0, eq).trim()
    const value = nameVal.substring(eq + 1).trim()
    if (name) hostJar.set(name, value)
  }
}

function getCookieHeader(urlStr) {
  const hostname = new URL(urlStr).hostname
  const hostJar = jar.get(hostname)
  if (!hostJar || hostJar.size === 0) return ''
  return [...hostJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function extractSessionCookie(urlStr) {
  const hostname = new URL(urlStr).hostname
  const hostJar = jar.get(hostname)
  return hostJar?.get('session') || null
}

// ---------------------------------------------------------------------------
// Fetch wrapper — manual redirect, cookie jar
// ---------------------------------------------------------------------------

async function req(url, options = {}) {
  const cookieStr = getCookieHeader(url)
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.5',
    ...(cookieStr ? { Cookie: cookieStr } : {}),
    ...options.headers,
  }

  const res = await undiciF(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ?? undefined,
    redirect: 'manual',
    ...(dispatcher ? { dispatcher } : {}),
  })

  storeCookies(url, res.headers)
  return res
}

// ---------------------------------------------------------------------------
// $Config parser
// ---------------------------------------------------------------------------

function parseConfig(html) {
  // Microsoft embeds server-side config as: $Config = {...};
  const match = html.match(/\$Config\s*=\s*(\{[\s\S]*?\});\s*(?:\/\/\]\]>|<\/script>|\n)/m)
  if (match) {
    try {
      return JSON.parse(match[1])
    } catch (_) {
      // fall through to field-by-field extraction
    }
  }

  // Fallback: extract individual fields
  const get = (key) => {
    const m = html.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm'))
    return m ? m[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"') : null
  }

  const urlPost = get('urlPost')
  const sFT = get('sFT')

  if (!urlPost) {
    throw new Error('Could not find urlPost in page HTML — $Config parse failed')
  }

  return { urlPost, sFT, sCtx: get('sCtx'), canary: get('canary') }
}

// ---------------------------------------------------------------------------
// Redirect follower — stops at non-redirect responses
// ---------------------------------------------------------------------------

async function followRedirects(initialRes, initialUrl, maxHops = 15) {
  let res = initialRes
  let url = initialUrl

  for (let i = 0; i < maxHops; i++) {
    if (res.status < 300 || res.status >= 400) break
    let location = res.headers.get('location')
    if (!location) break
    if (!location.startsWith('http')) location = new URL(location, url).href
    console.log(`[http-auth]   → ${location.substring(0, 100)}`)
    res = await req(location)
    url = location
  }

  return { res, url }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function generateSessionCookie({ appUrl, username, password, outputFile }) {
  // ── Step 1: GET CW root ───────────────────────────────────────────────────
  console.log(`[http-auth] Step 1: GET ${appUrl}`)
  let res = await req(appUrl)

  let location = res.headers.get('location')
  if (!location) {
    // Possibly already 200 — unexpected
    throw new Error(`Expected 302 from CW root, got ${res.status}`)
  }

  if (!location.startsWith('http')) location = new URL(location, appUrl).href
  console.log(`[http-auth] CW → ${location.substring(0, 100)}...`)

  // Follow any intermediate redirects until we reach Microsoft
  if (!location.includes('login.microsoftonline.com')) {
    res = await req(location)
    const followed = await followRedirects(res, location)
    res = followed.res
    location = followed.url
  }

  if (!location.includes('login.microsoftonline.com')) {
    throw new Error(`Did not reach Microsoft login. Got: ${location}`)
  }

  const microsoftAuthUrl = location

  // ── Step 2: GET Microsoft auth page ──────────────────────────────────────
  console.log(`[http-auth] Step 2: GET Microsoft auth URL`)
  res = await req(microsoftAuthUrl)

  const { res: msRes, url: msUrl } = await followRedirects(res, microsoftAuthUrl)
  res = msRes
  let currentUrl = msUrl

  if (res.status !== 200) {
    throw new Error(`Microsoft auth page status: ${res.status}`)
  }

  let html = await res.text()
  console.log(`[http-auth] Microsoft login HTML: ${html.length} bytes`)

  let config
  try {
    config = parseConfig(html)
  } catch (e) {
    console.log(`[http-auth] HTML snippet (head, first 2000):\n${html.substring(0, 2000)}`)
    throw e
  }
  console.log(`[http-auth] urlPost: ${config.urlPost?.substring(0, 80)}...`)

  // ── Step 3: POST username ─────────────────────────────────────────────────
  console.log(`[http-auth] Step 3: POST username`)
  res = await req(config.urlPost, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: currentUrl,
    },
    body: new URLSearchParams({
      i13: '0',
      login: username,
      loginfmt: username,
      type: '11',
      LoginOptions: '3',
      lrt: '',
      lrtPartition: '',
      hisRegion: '',
      hisScaleUnit: '',
      ctx: config.sCtx || '',
      flowToken: config.sFT || '',
      canary: config.canary || '',
      ipt: '0',
      i19: '30000',
    }).toString(),
  })

  const { res: res3, url: url3 } = await followRedirects(res, config.urlPost)
  res = res3
  currentUrl = url3

  if (res.status !== 200) {
    throw new Error(`Username POST response status: ${res.status}`)
  }

  html = await res.text()
  console.log(`[http-auth] Password page HTML: ${html.length} bytes`)

  let config2
  try {
    config2 = parseConfig(html)
  } catch (e) {
    console.log(`[http-auth] HTML snippet:\n${html.substring(0, 2000)}`)
    throw new Error(`Password page parse failed: ${e.message}`)
  }

  // ── Step 4: POST password ─────────────────────────────────────────────────
  console.log(`[http-auth] Step 4: POST password`)
  const passwordPostUrl = config2.urlPost || config.urlPost
  res = await req(passwordPostUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: currentUrl,
    },
    body: new URLSearchParams({
      i13: '0',
      login: username,
      loginfmt: username,
      passwd: password,
      type: '11',
      LoginOptions: '1',
      lrt: '',
      lrtPartition: '',
      hisRegion: '',
      hisScaleUnit: '',
      ctx: config2.sCtx || config.sCtx || '',
      flowToken: config2.sFT || config.sFT || '',
      canary: config2.canary || config.canary || '',
      ps: '2',
      ipt: '0',
      i19: '30000',
    }).toString(),
  })
  currentUrl = passwordPostUrl

  // ── Step 5: Follow redirect chain to CW callback ──────────────────────────
  console.log(`[http-auth] Step 5: Following redirect chain`)
  let sessionCookie = null
  let hops = 0
  const maxHops = 25

  while (hops++ < maxHops) {
    // Check cookie jar for session cookie from CW frontend
    const cwUrl = new URL(appUrl)
    const cwSession = jar.get(cwUrl.hostname)?.get('session')
    if (cwSession) {
      sessionCookie = cwSession
      console.log(`[http-auth] Got session cookie (length ${sessionCookie.length})`)
      break
    }

    if (res.status >= 300 && res.status < 400) {
      let next = res.headers.get('location')
      if (!next) break
      if (!next.startsWith('http')) next = new URL(next, currentUrl).href
      console.log(`[http-auth]   hop ${hops}: ${next.substring(0, 100)}`)
      res = await req(next)
      currentUrl = next
      continue
    }

    if (res.status === 200) {
      html = await res.text()

      // "Stay signed in?" (KMSI) page
      if (html.includes('idBtn_Back') || html.includes('kmsi')) {
        console.log(`[http-auth] "Stay signed in?" — declining`)
        let kmsiConfig
        try {
          kmsiConfig = parseConfig(html)
        } catch (_) {
          // Can't parse KMSI config — try POSTing with type=28 to same URL
          kmsiConfig = { urlPost: currentUrl, sFT: config2.sFT || config.sFT, sCtx: config2.sCtx || config.sCtx }
        }
        res = await req(kmsiConfig.urlPost || currentUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            LoginOptions: '1',
            type: '28',
            ctx: kmsiConfig.sCtx || '',
            flowToken: kmsiConfig.sFT || '',
            hisRegion: '',
            hisScaleUnit: '',
            canary: kmsiConfig.canary || '',
          }).toString(),
        })
        currentUrl = kmsiConfig.urlPost || currentUrl
        continue
      }

      // Unexpected 200 — log and fail
      console.log(`[http-auth] Unexpected 200 at ${currentUrl}`)
      console.log(`[http-auth] HTML snippet:\n${html.substring(0, 1000)}`)
      throw new Error(`Unexpected non-redirect 200 at ${currentUrl}`)
    }

    break
  }

  if (!sessionCookie) {
    throw new Error('OAuth flow completed but no session cookie found in CW frontend cookie jar')
  }

  // ── Step 6: Append to CSV ─────────────────────────────────────────────────
  await fs.mkdir(path.dirname(outputFile), { recursive: true })
  await fs.appendFile(outputFile, `session=${sessionCookie}\n`, 'utf-8')
  console.log(`[http-auth] Appended cookie to ${outputFile}`)
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const username = process.env.ENTRA_ID_WRITER_USER
const password = process.env.ENTRA_ID_USER_PASSWORD
const appUrl = process.env.CW_FRONTEND_URL
const outputFile = process.env.OUTPUT_FILE || '/app/src/data/frps-session-cookies.csv'

if (!username || !password || !appUrl) {
  console.error('[http-auth] Missing required env vars: CW_FRONTEND_URL, ENTRA_ID_WRITER_USER, ENTRA_ID_USER_PASSWORD')
  process.exit(1)
}

try {
  await generateSessionCookie({ appUrl, username, password, outputFile })
  console.log('[http-auth] Done')
  process.exit(0)
} catch (err) {
  console.error('[http-auth] FAILED:', err.message)
  if (err.cause) console.error('[http-auth] Cause:', err.cause)
  process.exit(1)
}
