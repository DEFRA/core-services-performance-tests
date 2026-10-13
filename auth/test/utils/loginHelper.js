import fs from 'node:fs/promises'
import path from 'node:path'

const COOKIE_NAME = 'session'
const MICROSOFT_HOSTS = ['login.microsoftonline.com', 'login.live.com']

/**
 * Log in via Microsoft Entra ID and append the `session` cookie to the CSV output file.
 *
 * @param {string} username
 * @param {string} password
 * @param {{ appUrl: string, outputFile: string }} options
 */
export async function loginAndAppendSessionCookie(username, password, { appUrl, outputFile }) {
  await performLogin(username, password)
  await waitForAppLoad(appUrl)

  const currentUrl = await browser.getUrl()
  console.log(`Logged in. Current URL: ${currentUrl}`)

  const isMicrosoftUrl = MICROSOFT_HOSTS.some((h) => currentUrl.includes(h))
  if (isMicrosoftUrl) {
    throw new Error(`Still on Microsoft login page after login: ${currentUrl}`)
  }

  // Navigate to /cases to ensure the session cookie is fully set
  const casesUrl = `${appUrl.replace(/\/cases\/?$/, '').replace(/\/$/, '')}/cases`
  console.log(`Navigating to cases page: ${casesUrl}`)
  await browser.url(casesUrl)
  await browser.pause(3000)

  const cookies = await browser.getCookies()
  console.log(`Cookies found: ${cookies.map((c) => c.name).join(', ')}`)

  const sessionCookie = cookies.find((c) => c.name === COOKIE_NAME)
  if (!sessionCookie?.value) {
    throw new Error(
      `Login succeeded but "${COOKIE_NAME}" cookie not found. Found: ${cookies.map((c) => c.name).join(', ')}`
    )
  }

  const cookieHeader = `${COOKIE_NAME}=${sessionCookie.value}`
  console.log(`Got session cookie (length ${sessionCookie.value.length})`)

  await fs.mkdir(path.dirname(outputFile), { recursive: true })
  await fs.appendFile(outputFile, cookieHeader + '\n', 'utf-8')
  console.log(`Appended cookie to ${outputFile}`)
}

async function findVisibleElement(selector, timeout = 30000) {
  await browser.waitUntil(
    async () => {
      const elements = await $$(selector)
      for (const el of elements) {
        if (await el.isDisplayed()) return true
      }
      return false
    },
    { timeout, interval: 500, timeoutMsg: `No visible element for: ${selector}` }
  )

  const elements = await $$(selector)
  for (const el of elements) {
    if (await el.isDisplayed()) return el
  }
  throw new Error(`Visible element vanished: ${selector}`)
}

async function performLogin(username, password) {
  console.log('Waiting for email field...')
  const emailField = await findVisibleElement('input[name="loginfmt"]', 15000)
  await emailField.setValue(username)

  console.log('Clicking Next...')
  const nextButton = await findVisibleElement('#idSIButton9', 10000)
  await nextButton.waitForClickable({ timeout: 10000 })
  await nextButton.click()

  console.log('Waiting for password field...')
  await browser.waitUntil(
    async () => {
      const pwds = await $$('input[name="passwd"]')
      for (const el of pwds) {
        if (await el.isDisplayed()) return true
      }
      return false
    },
    { timeout: 30000, interval: 500, timeoutMsg: 'Password field did not appear after clicking Next' }
  )

  const passwordField = await findVisibleElement('input[name="passwd"]', 5000)
  await passwordField.setValue(password)

  await clickSignInWithRetry()
}

async function clickSignInWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`Sign In attempt ${attempt}/${maxRetries}`)

    const signInButton = await $('#idSIButton9')
    await signInButton.waitForDisplayed({ timeout: 10000 })
    await signInButton.waitForEnabled({ timeout: 10000 })
    await signInButton.scrollIntoView()
    await signInButton.click()
    await browser.pause(3000)

    // Dismiss "Stay signed in?" if present
    const staySignedIn = await $('#idBtn_Back')
    if (await staySignedIn.isDisplayed()) {
      console.log('Dismissing "Stay signed in?" prompt...')
      await staySignedIn.click()
      await browser.pause(3000)
    }

    const currentUrl = await browser.getUrl()
    console.log(`Current URL: ${currentUrl}`)

    if (!currentUrl.includes('login.microsoftonline.com')) {
      console.log('Left Microsoft login page')
      return
    }

    if (attempt === maxRetries) {
      throw new Error('Login stuck on Microsoft login page after multiple retries')
    }
    console.warn(`Still on login page, retrying...`)
  }
}

async function waitForAppLoad(appUrl) {
  const expectedHost = new URL(appUrl).hostname
  let retryCount = 0
  const maxRetries = 2

  await browser.waitUntil(
    async () => {
      const currentUrl = await browser.getUrl()
      if (currentUrl.includes(expectedHost)) return true

      if (MICROSOFT_HOSTS.some((h) => currentUrl.includes(h)) && retryCount < maxRetries) {
        retryCount++
        console.log(`Still on Microsoft page, retry ${retryCount}/${maxRetries}`)
        await browser.pause(2000)
      }
      return false
    },
    { timeout: 60000, interval: 2000, timeoutMsg: 'App did not load after Entra ID login' }
  )
}
