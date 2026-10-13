/**
 * generate-session-cookies.js
 *
 * Logs into the CW frontend via Microsoft Entra ID and writes session cookies
 * to a CSV file for use by K6 scenarios. Run this before any K6 test that
 * exercises the CW frontend (frps-full-journey, wmp-cw-journey).
 *
 * Each login uses an isolated browser context so cookies don't bleed between
 * sessions. Microsoft Entra ID will issue a separate session token per context.
 *
 * Usage:
 *   npm run generate-cookies
 *
 * Required env vars:
 *   CW_FRONTEND_URL        e.g. https://fg-cw-frontend.perf-test.cdp-int.defra.cloud
 *   ENTRA_ID_WRITER_USER   caseworker username (email)
 *   ENTRA_ID_USER_PASSWORD caseworker password
 *
 * Optional env vars:
 *   SESSION_COUNT          number of sessions to generate (default: 10)
 *   OUTPUT_FILE            path to write CSV (default: src/data/cw-session-cookies.csv)
 *   HEADLESS               set to "false" to watch the browser (default: true)
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const CW_URL = process.env.CW_FRONTEND_URL;
const USERNAME = process.env.ENTRA_ID_WRITER_USER;
const PASSWORD = process.env.ENTRA_ID_USER_PASSWORD;
const SESSION_COUNT = parseInt(process.env.SESSION_COUNT ?? '10', 10);
const OUTPUT_FILE = process.env.OUTPUT_FILE ?? `${__dirname}/../src/data/cw-session-cookies.csv`;
const HEADLESS = process.env.HEADLESS !== 'false';

const LOGIN_TIMEOUT = 30_000;
const POST_LOGIN_TIMEOUT = 30_000;
const MICROSOFT_HOSTS = ['login.microsoftonline.com', 'login.live.com'];

// ── Validation ────────────────────────────────────────────────────────────────

if (!CW_URL || !USERNAME || !PASSWORD) {
  console.error('Missing required env vars: CW_FRONTEND_URL, ENTRA_ID_WRITER_USER, ENTRA_ID_USER_PASSWORD');
  process.exit(1);
}

// ── Entra ID login ────────────────────────────────────────────────────────────

async function entraLogin(page) {
  const isMicrosoftUrl = () => MICROSOFT_HOSTS.some((h) => page.url().includes(h));

  const fill = async (selector, value) => {
    await page.waitForSelector(selector, { state: 'visible', timeout: LOGIN_TIMEOUT });
    await page.click(selector);
    await page.fill(selector, value);
  };

  const click = async (selector) => {
    await page.waitForSelector(selector, { state: 'visible', timeout: LOGIN_TIMEOUT });
    await page.click(selector);
  };

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`  Entra login attempt ${attempt}/${MAX_ATTEMPTS}`);

      // Enter username — use name attribute (more stable than id across MS login page versions)
      await fill('input[name="loginfmt"]', USERNAME);
      await click('#idSIButton9');

      // Enter password
      await fill('input[name="passwd"]', PASSWORD);
      await click('#idSIButton9');

      await page.waitForTimeout(1000);

      // Dismiss "Stay signed in?" prompt if present
      try {
        await page.waitForSelector('#idSIButton9', { state: 'visible', timeout: 3000 });
        if (isMicrosoftUrl()) {
          console.log('  Dismissing "Stay signed in?" prompt');
          await page.click('#idSIButton9');
        }
      } catch {
        // prompt not shown — continue
      }

      // Wait until we're back on the CW frontend
      await page.waitForFunction(
        (hosts) => !hosts.some((h) => window.location.href.includes(h)),
        MICROSOFT_HOSTS,
        { timeout: POST_LOGIN_TIMEOUT },
      );

      console.log('  Login successful');
      return;
    } catch (err) {
      console.warn(`  Attempt ${attempt} failed: ${err.message}`);

      if (attempt === MAX_ATTEMPTS) throw err;

      if (isMicrosoftUrl()) {
        await page.reload();
      } else {
        await page.goto(`${CW_URL.replace(/\/cases\/?$/, '').replace(/\/$/, '')}/login`, { waitUntil: 'domcontentloaded' });
      }
      await page.waitForTimeout(2000);
    }
  }
}

// ── Generate one session ──────────────────────────────────────────────────────

async function generateSession(browser, index) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const baseUrl = CW_URL.replace(/\/cases\/?$/, '').replace(/\/$/, '');
    const loginUrl = `${baseUrl}/login`;
    console.log(`[${index + 1}/${SESSION_COUNT}] Navigating to ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    await entraLogin(page);

    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'session');

    if (!sessionCookie) {
      throw new Error('session cookie not found after login');
    }

    console.log(`[${index + 1}/${SESSION_COUNT}] Got session cookie`);
    return `session=${sessionCookie.value}`;
  } finally {
    await context.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Generating ${SESSION_COUNT} CW session cookies`);
  console.log(`  User: ${USERNAME}`);
  console.log(`  URL:  ${CW_URL}`);
  console.log(`  Out:  ${OUTPUT_FILE}`);
  console.log('');

  const browser = await chromium.launch({ headless: HEADLESS });

  const cookies = [];

  try {
    // Run sequentially — parallel Entra logins from the same account can
    // trigger MFA prompts or rate limiting
    for (let i = 0; i < SESSION_COUNT; i++) {
      const cookie = await generateSession(browser, i);
      cookies.push(cookie);
    }
  } finally {
    await browser.close();
  }

  const csv = ['cookieHeader', ...cookies].join('\n') + '\n';

  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, csv, 'utf8');

  console.log(`\nWrote ${cookies.length} session cookies to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Failed to generate session cookies:', err);
  process.exit(1);
});
