/**
 * Generate CW frontend session cookies for k6.
 *
 * COOKIE_GENERATION_MODE=browser (default): existing Entra login, with CDN diagnostics.
 * COOKIE_GENERATION_MODE=session-factory: browserless, but requires an IMPLEMENTED,
 * test-environment-only CW endpoint that issues the normal session cookie.
 *
 * Required in both modes: CW_FRONTEND_URL
 * Browser mode: ENTRA_ID_WRITER_USER, ENTRA_ID_USER_PASSWORD
 * Session-factory mode: CW_SESSION_FACTORY_URL, CW_SESSION_FACTORY_TOKEN,
 *                       CW_TEST_USER_ID
 * Optional: SESSION_COUNT (default 10), OUTPUT_FILE, HEADLESS,
 *           PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, LOGIN_TIMEOUT_MS.
 */

import { chromium } from 'playwright';
import { request as httpsRequest } from 'node:https';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CW_URL = process.env.CW_FRONTEND_URL?.replace(/\/$/, '');
const USERNAME = process.env.ENTRA_ID_WRITER_USER;
const PASSWORD = process.env.ENTRA_ID_USER_PASSWORD;
const MODE = process.env.COOKIE_GENERATION_MODE || 'browser';
const SESSION_COUNT = Number(process.env.SESSION_COUNT || '10');
const OUTPUT_FILE = process.env.OUTPUT_FILE || `${__dirname}/../src/data/cw-session-cookies.csv`;
const LOGIN_TIMEOUT = Number(process.env.LOGIN_TIMEOUT_MS || '20000');
const POST_LOGIN_TIMEOUT = 30_000;
const MAX_ATTEMPTS = 3;

if (!CW_URL || !['browser', 'session-factory'].includes(MODE) ||
    !Number.isInteger(SESSION_COUNT) || SESSION_COUNT < 1 ||
    !Number.isFinite(LOGIN_TIMEOUT) || LOGIN_TIMEOUT < 1000) {
  throw new Error('Invalid CW_FRONTEND_URL, COOKIE_GENERATION_MODE, SESSION_COUNT or LOGIN_TIMEOUT_MS');
}
const CW_ORIGIN = new URL(CW_URL).origin;
const CW_HOST = new URL(CW_URL).hostname;
if (new URL(CW_URL).protocol !== 'https:') {
  throw new Error('CW_FRONTEND_URL must use HTTPS');
}

function hostname(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}
function safeLocation(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`; // never log OAuth codes, state or tokens
  } catch { return '(unparseable URL)'; }
}
function isMicrosoft(value) {
  return ['login.microsoftonline.com', 'login.live.com'].includes(hostname(value));
}
function isAuthCdn(value) {
  const host = hostname(value);
  return host === 'aadcdn.msauth.net' || host === 'aadcdn.msftauth.net' ||
    host.endsWith('.msauth.net') || host.endsWith('.msftauth.net') ||
    host.endsWith('.msauthimages.net') || host.endsWith('.msftauthimages.net');
}

function installNetworkDiagnostics(page) {
  const diagnostic = {
    cdnRequests: 0,
    cdnFailures: [],
    otherFailures: [],
    pageErrors: 0,
  };

  page.on('request', request => {
    if (isAuthCdn(request.url())) diagnostic.cdnRequests += 1;
  });
  page.on('requestfailed', request => {
    const info = `${request.resourceType()} ${safeLocation(request.url())} ` +
      `${request.failure()?.errorText || '(unknown network error)'}`;
    if (isAuthCdn(request.url())) {
      diagnostic.cdnFailures.push(info);
      console.error(`  CDN REQUEST FAILED: ${info}`);
    } else if (hostname(request.url()) !== CW_HOST) {
      diagnostic.otherFailures.push(info);
      console.error(`  EXTERNAL REQUEST FAILED: ${info}`);
    }
  });
  page.on('response', response => {
    if (!isAuthCdn(response.url())) return;
    const contentType = response.headers()['content-type'] || '';
    const suspiciousScript = response.request().resourceType() === 'script' &&
      /^text\/html\b/i.test(contentType);
    if (response.status() < 400 && !suspiciousScript) return;
    const info = `HTTP ${response.status()} ${safeLocation(response.url())}` +
      (suspiciousScript ? ' (HTML returned for JavaScript)' : '');
    diagnostic.cdnFailures.push(info);
    console.error(`  CDN HTTP ERROR: ${info}`);
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const sanitized = message.text()
      .replace(/https?:\/\/[^\s\"'<>)]*/g, value => safeLocation(value))
      .replaceAll(PASSWORD || '\u0000', '[REDACTED]')
      .replaceAll(USERNAME || '\u0000', '[REDACTED]');
    console.error(`  BROWSER CONSOLE ERROR: ${sanitized.slice(0, 350)}`);
  });
  page.on('pageerror', error => {
    diagnostic.pageErrors += 1;
    // Deliberately avoid dumping arbitrary messages: Microsoft URLs can carry auth parameters.
    console.error(`  PAGE JAVASCRIPT ERROR: ${error.name || 'Error'} (details suppressed)`);
  });
  return diagnostic;
}

async function requireLoginForm(page, diagnostic) {
  try {
    await page.locator('input[name="loginfmt"]').waitFor({
      state: 'visible', timeout: LOGIN_TIMEOUT,
    });
  } catch (error) {
    console.error(`  Current page: ${safeLocation(page.url())}`);
    console.error(`  CDN requests seen: ${diagnostic.cdnRequests}`);
    console.error(`  CDN request failures / HTTP errors: ${diagnostic.cdnFailures.length}`);
    console.error(`  Other external request failures: ${diagnostic.otherFailures.length}`);
    console.error(`  Page JavaScript errors: ${diagnostic.pageErrors}`);
    const scriptHosts = await page.locator('script[src]').evaluateAll(nodes =>
      [...new Set(nodes.map(node => {
        try { return new URL(node.src).hostname; } catch { return '(unknown)'; }
      }))],
    ).catch(() => []);
    console.error(`  Script hostnames in document: ${scriptHosts.join(', ') || '(none)'}`);

    if (diagnostic.cdnFailures.length > 0) {
      const failure = new Error(
        'MICROSOFT_AUTH_CDN_FAILED: required Microsoft authentication assets ' +
        'were not retrieved. Check CDP squid rules/TLS connectivity; retrying the ' +
        'same Playwright selector will not fix a persistent proxy denial.',
      );
      failure.code = 'MICROSOFT_AUTH_CDN_FAILED';
      throw failure;
    }
    throw new Error(
      `Entra login input did not become visible after ${LOGIN_TIMEOUT}ms. ` +
      'Examine the request/pageerror diagnostics; do not infer a CDN denial from HTML alone.',
      { cause: error },
    );
  }
}

async function entraLogin(page, diagnostic) {
  const fill = async (selector, value) => {
    await page.locator(selector).fill(value, { timeout: LOGIN_TIMEOUT });
  };
  const click = async selector => {
    await page.locator(selector).click({ timeout: LOGIN_TIMEOUT });
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`  Entra attempt ${attempt}/${MAX_ATTEMPTS} at ${safeLocation(page.url())}`);
      await requireLoginForm(page, diagnostic);
      await fill('input[name="loginfmt"]', USERNAME);
      await click('#idSIButton9');
      await fill('input[name="passwd"]', PASSWORD);
      await click('#idSIButton9');

      // Optional Microsoft "Stay signed in?" page. A separate prompt may not appear.
      try {
        await page.getByText('Stay signed in?', { exact: false }).waitFor({
          state: 'visible', timeout: 4_000,
        });
        if (isMicrosoft(page.url())) await click('#idSIButton9');
      } catch {
        // Not present, already navigated, or still loading.
      }

      await page.waitForURL(url =>
        url.hostname === CW_HOST &&
        !['/login', '/login/callback'].includes(url.pathname),
      { waitUntil: 'domcontentloaded', timeout: POST_LOGIN_TIMEOUT });
      return;
    } catch (error) {
      console.warn(`  Attempt ${attempt} failed: ${error.message}`);
      if (error.code === 'MICROSOFT_AUTH_CDN_FAILED' || attempt === MAX_ATTEMPTS) {
        throw error;
      }
      if (isMicrosoft(page.url())) {
        await page.reload({ waitUntil: 'domcontentloaded' });
      } else {
        // Start a fresh login rather than reusing potentially invalid OAuth state.
        await page.goto(`${CW_ORIGIN}/login`, { waitUntil: 'domcontentloaded' });
      }
    }
  }
}

async function generateBrowserSession(browser, index) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const diagnostic = installNetworkDiagnostics(page); // attach BEFORE navigation
  try {
    console.log(`[${index + 1}/${SESSION_COUNT}] Opening ${CW_ORIGIN}/login`);
    await page.goto(`${CW_ORIGIN}/login`, { waitUntil: 'domcontentloaded' });
    await entraLogin(page, diagnostic);
    const cookies = await context.cookies([CW_ORIGIN]); // restrict to CW, not Microsoft
    const session = cookies.find(cookie => cookie.name === 'session' &&
      (CW_HOST === cookie.domain.replace(/^\./, '') ||
       CW_HOST.endsWith(`.${cookie.domain.replace(/^\./, '')}`)));
    if (!session) throw new Error('CW session cookie missing following OIDC callback');
    console.log(`[${index + 1}/${SESSION_COUNT}] CW cookie captured`);
    return `session=${session.value}`;
  } finally {
    await context.close();
  }
}

function createFactorySession(index) {
  // This does NOT call a Microsoft endpoint and will NOT work until the CW
  // frontend implements an authorized test-only endpoint that sets its real cookie.
  const endpoint = new URL(process.env.CW_SESSION_FACTORY_URL);
  if (endpoint.origin !== CW_ORIGIN) {
    throw new Error('CW_SESSION_FACTORY_URL must be on the CW frontend origin');
  }
  const body = JSON.stringify({ testUserId: process.env.CW_TEST_USER_ID });
  return new Promise((resolve, reject) => {
    const req = httpsRequest(endpoint, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${process.env.CW_SESSION_FACTORY_TOKEN}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      // Do not log the response body, authorization header, or session values.
      const setCookies = response.headers['set-cookie'] || [];
      const match = setCookies
        .map(value => /^session=([^;]*)/i.exec(value))
        .find(Boolean);
      response.resume();
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`Session factory responded HTTP ${response.statusCode}`));
        }
        if (!match || !match[1]) {
          return reject(new Error('Session factory returned no session Set-Cookie header'));
        }
        console.log(`[${index + 1}/${SESSION_COUNT}] CW cookie captured`);
        resolve(`session=${match[1]}`);
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('Session factory request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function writeCsv(cookies) {
  const csv = ['cookieHeader', ...cookies].join('\n') + '\n';
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  const tempFile = `${OUTPUT_FILE}.${process.pid}.tmp`;
  writeFileSync(tempFile, csv, { encoding: 'utf8', mode: 0o600 });
  renameSync(tempFile, OUTPUT_FILE);
  console.log(`Wrote ${cookies.length} CW session cookies to ${OUTPUT_FILE}`);
}

async function main() {
  console.log(`Generating ${SESSION_COUNT} CW sessions (mode: ${MODE})`);
  const cookies = [];

  if (MODE === 'session-factory') {
    if (!process.env.CW_SESSION_FACTORY_URL || !process.env.CW_SESSION_FACTORY_TOKEN ||
        !process.env.CW_TEST_USER_ID) {
      throw new Error('session-factory mode requires CW_SESSION_FACTORY_URL, ' +
        'CW_SESSION_FACTORY_TOKEN, CW_TEST_USER_ID');
    }
    for (let i = 0; i < SESSION_COUNT; i++) {
      cookies.push(await createFactorySession(i));
    }
  } else {
    if (!USERNAME || !PASSWORD) {
      throw new Error('Browser mode requires ENTRA_ID_WRITER_USER, ENTRA_ID_USER_PASSWORD');
    }
    const flags = [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-infobars', '--window-size=1920,1080',
      '--disable-http2', '--dns-prefetch-disable',
      '--password-store=basic', '--use-mock-keychain',
    ];
    // Only use this temporarily if CDP certificate trust has not been configured.
    if (process.env.ALLOW_INSECURE_TLS === 'true') flags.push('--ignore-certificate-errors');

    const proxyString = process.env.HTTPS_PROXY || process.env.CDP_HTTPS_PROXY ||
      process.env.HTTP_PROXY || process.env.CDP_HTTP_PROXY || 'http://localhost:3128';
    const proxyURL = new URL(proxyString);
    const options = {
      headless: process.env.HEADLESS !== 'false',
      args: flags,
      proxy: {
        server: `${proxyURL.protocol}//${proxyURL.host}`,
        bypass: '.cdp-int.defra.cloud,localhost,127.0.0.1',
        ...(proxyURL.username ? { username: decodeURIComponent(proxyURL.username) } : {}),
        ...(proxyURL.password ? { password: decodeURIComponent(proxyURL.password) } : {}),
      },
    };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }
    console.log(`Browser proxy: ${proxyURL.protocol}//${proxyURL.host}`);
    const browser = await chromium.launch(options);
    try {
      for (let i = 0; i < SESSION_COUNT; i++) {
        cookies.push(await generateBrowserSession(browser, i));
      }
    } finally {
      await browser.close();
    }
  }
  if (new Set(cookies).size !== cookies.length) {
    throw new Error('Duplicate CW session cookies returned; cannot supply independent sessions');
  }
  writeCsv(cookies);
}

main().catch(error => {
  console.error(`Session generation failed: ${error.message}`);
  process.exitCode = 1;
});
