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

    const loginUrl = `${appUrl.replace(/\/cases\/?$/, '').replace(/\/$/, '')}/login`
    console.log(`Navigating to: ${loginUrl}`)
    await browser.url(loginUrl)

    await loginAndAppendSessionCookie(username, password, {
      appUrl,
      outputFile,
    })
  })
})
