import fs from 'fs'
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

// ── State ──────────────────────────────────────────────────────────────────────

let chromedriverProcess

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
              '--headless',
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
            ],
      },
      pageLoadStrategy: 'eager',
      // In CDP: route browser traffic through the local squid sidecar.
      // localhost:3128 allows Microsoft CDN (aadcdn.msauth.net) needed for login form.
      // Skip when running locally (LOCAL=true) or in debug mode.
      ...(debug || local
        ? {}
        : {
            proxy: {
              proxyType: 'manual',
              httpProxy: 'localhost:3128',
              sslProxy: 'localhost:3128',
            },
          }),
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
