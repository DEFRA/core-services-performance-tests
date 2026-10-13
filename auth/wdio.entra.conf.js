import fs from 'fs'
import http from 'http'
import tls from 'tls'
import net from 'net'
import { URL } from 'url'
import { spawn } from 'node:child_process'

const debug = process.env.DEBUG === 'true'
const local = process.env.LOCAL === 'true'

// Use system chromedriver from Alpine package (chromium-chromedriver) if available,
// otherwise use npm package (for local development)
const systemChromedriverPath = '/usr/bin/chromedriver'
const npmChromedriverPath = './node_modules/chromedriver/lib/chromedriver/chromedriver'
const chromedriverPath = fs.existsSync(systemChromedriverPath)
  ? systemChromedriverPath
  : npmChromedriverPath

// Tell ChromeDriver where Chromium is when running in Docker (Alpine).
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is already set in the Dockerfile.
const systemChromiumPath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : null)

// CDP_HTTPS_PROXY carries credentials (https://user:pass@host).
// localhost:3128 (ECS squid) blocks CONNECT to aadcdn.msauth.net which renders
// the Microsoft login form. We start a local relay proxy that forwards all
// CONNECT requests to the external CDP proxy with credentials injected, so
// Chrome can reach the CDN without needing to handle proxy auth itself.
const cdpProxy = process.env.CDP_HTTPS_PROXY
const RELAY_PORT = 3129

// ── Local relay proxy ──────────────────────────────────────────────────────────

async function startRelayProxy(localPort, upstreamUrl) {
  const upstream = new URL(upstreamUrl)
  const upstreamPort = parseInt(upstream.port) || (upstream.protocol === 'https:' ? 443 : 3128)
  const authBase64 = Buffer.from(
    `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`
  ).toString('base64')

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(400)
      res.end('CONNECT only')
    })

    server.on('connect', (req, clientSocket, head) => {
      const upstreamSocket =
        upstream.protocol === 'https:'
          ? tls.connect({ host: upstream.hostname, port: upstreamPort, rejectUnauthorized: false })
          : net.connect({ host: upstream.hostname, port: upstreamPort })

      upstreamSocket.on('connect', () => {
        upstreamSocket.write(
          `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: Basic ${authBase64}\r\n\r\n`
        )

        let buf = Buffer.alloc(0)
        const onData = (chunk) => {
          buf = Buffer.concat([buf, chunk])
          const end = buf.indexOf('\r\n\r\n')
          if (end === -1) return
          upstreamSocket.removeListener('data', onData)

          const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString()
          const rest = buf.slice(end + 4)

          if (statusLine.includes(' 200 ')) {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (head.length > 0) upstreamSocket.write(head)
            if (rest.length > 0) clientSocket.write(rest)
            upstreamSocket.pipe(clientSocket)
            clientSocket.pipe(upstreamSocket)
          } else {
            console.error(`Relay: upstream rejected ${req.url}: ${statusLine}`)
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
            clientSocket.destroy()
            upstreamSocket.destroy()
          }
        }
        upstreamSocket.on('data', onData)
      })

      upstreamSocket.on('error', (err) => {
        console.error(`Relay upstream error (${req.url}):`, err.message)
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        clientSocket.destroy()
      })

      clientSocket.on('error', () => upstreamSocket.destroy())
      upstreamSocket.on('close', () => clientSocket.destroy())
      clientSocket.on('close', () => upstreamSocket.destroy())
    })

    server.on('error', reject)
    server.listen(localPort, '127.0.0.1', () => {
      console.log(
        `Relay proxy started on localhost:${localPort} → ${upstream.hostname}:${upstreamPort}`
      )
      resolve(server)
    })
  })
}

// ── Chrome proxy args ──────────────────────────────────────────────────────────

// In CDP: route browser traffic through the relay (which authenticates to the external proxy).
// Bypass for internal .cdp-int.defra.cloud services (directly accessible within CDP).
const proxyArgs =
  !debug && !local && cdpProxy
    ? [
        `--proxy-server=http://localhost:${RELAY_PORT}`,
        '--proxy-bypass-list=*.cdp-int.defra.cloud',
      ]
    : []

// ── State ──────────────────────────────────────────────────────────────────────

let chromedriverProcess
let relayServer = null

// ── WDIO config ────────────────────────────────────────────────────────────────

export const config = {
  runner: 'local',

  specs: ['./test/specs/generate-cookies.e2e.js'],

  exclude: [],

  maxInstances: 1,

  protocol: 'http',
  hostname: 'localhost',
  port: 9515,
  path: '/',

  capabilities: [
    {
      maxInstances: 1,
      browserName: 'chrome',
      'wdio:enforceWebDriverClassic': true,
      'goog:chromeOptions': {
        ...(systemChromiumPath ? { binary: systemChromiumPath } : {}),
        args: debug
          ? ['--disable-infobars', '--window-size=1920,1080']
          : [
              '--no-sandbox',
              '--disable-infobars',
              '--headless=new',
              '--disable-gpu',
              '--window-size=1920,1080',
              '--enable-features=NetworkService,NetworkServiceInProcess',
              '--password-store=basic',
              '--use-mock-keychain',
              '--dns-prefetch-disable',
              '--disable-background-networking',
              '--disable-remote-fonts',
              '--ignore-certificate-errors',
              '--disable-dev-shm-usage',
              ...proxyArgs,
            ],
      },
      pageLoadStrategy: 'eager',
    },
  ],

  logLevel: debug ? 'debug' : 'info',
  bail: 1,
  waitforTimeout: 30000,
  waitforInterval: 200,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  framework: 'mocha',

  reporters: ['spec'],

  mochaOpts: {
    ui: 'bdd',
    timeout: debug ? 3600000 : 120000,
  },

  onPrepare: async function () {
    if (!debug && !local && cdpProxy) {
      relayServer = await startRelayProxy(RELAY_PORT, cdpProxy)
    }

    console.log(`Starting chromedriver from: ${chromedriverPath}`)
    chromedriverProcess = spawn(chromedriverPath, ['--port=9515'], {
      stdio: 'ignore',
      detached: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    console.log('Chromedriver started on port 9515')
  },

  onComplete: function () {
    if (chromedriverProcess) {
      console.log('Stopping chromedriver...')
      chromedriverProcess.kill()
    }
    if (relayServer) {
      relayServer.close()
      relayServer = null
    }
  },

  afterTest: async function (test, context, { error }) {
    if (error) {
      console.error('Test failed:', error.message)
    }
  },

  beforeTest: function (test) {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`Starting: ${test.title}`)
    console.log('='.repeat(60))
  },
}
