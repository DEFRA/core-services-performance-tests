import { loginAndAppendSessionCookie } from '../utils/loginHelper.js'

describe('CW session cookie generation', () => {
  it('should log in via Entra ID and append the session cookie to the CSV', async () => {
    const username = process.env.ENTRA_ID_WRITER_USER
    const password = process.env.ENTRA_ID_USER_PASSWORD
    const appUrl = process.env.CW_FRONTEND_URL
    const outputFile = process.env.OUTPUT_FILE || '/app/src/data/frps-session-cookies.csv'

    if (!username || !password || !appUrl) {
      throw new Error(
        'Required env vars missing: CW_FRONTEND_URL, ENTRA_ID_WRITER_USER, ENTRA_ID_USER_PASSWORD'
      )
    }

    console.log(`User:   ${username}`)
    console.log(`URL:    ${appUrl}`)
    console.log(`Output: ${outputFile}`)

    // Navigate to root — CW does a server-side 302 → Microsoft login.
    // Do NOT navigate to /login (CW's own page that JS-redirects; eager returns too early).
    console.log(`Navigating to: ${appUrl}`)
    await browser.url(appUrl)
    console.log(`URL after navigate: ${await browser.getUrl()}`)
    console.log(`Page title: ${await browser.getTitle()}`)

    // Diagnostic: check DOM state before attempting login
    const formImmediate = await browser.execute(() => !!document.querySelector('input[name="loginfmt"]'))
    console.log(`[diag] loginfmt in DOM immediately: ${formImmediate}`)
    await browser.pause(5000)
    const formAfterWait = await browser.execute(() => !!document.querySelector('input[name="loginfmt"]'))
    console.log(`[diag] loginfmt in DOM after 5s: ${formAfterWait}`)
    const bodySnippet = await browser.execute(() => document.body.innerHTML.substring(0, 500))
    console.log(`[diag] body HTML (first 500): ${bodySnippet}`)

    await loginAndAppendSessionCookie(username, password, {
      appUrl,
      outputFile,
    })
  })
})
