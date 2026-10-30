# core-services-performance-tests

A k6 performance test suite for FRPS and WMP on the CDP Platform. Playwright obtains the caseworker session cookies used by the tests.

- [Local setup](#local-setup)
- [CDP setup](#cdp-setup)
- [Running locally](#running-locally)
- [Quick run (smoke test)](#quick-run-smoke-test)
- [CDP Squid Proxy — Required Domain Allowlist](#cdp-squid-proxy--required-domain-allowlist)
- [WMP Full Journey — Prerequisites & Gotchas](#wmp-full-journey--prerequisites--gotchas)
- [Licence](#licence)

---

## Local setup

### 1. Install dependencies

```bash
npm ci
npx playwright install chromium
```

### 2. Create `.env`

Copy the template below and fill in the values. This file is gitignored — never commit it.

```
# CW frontend URL to log into
CW_FRONTEND_URL=https://fg-cw-frontend.perf-test.cdp-int.defra.cloud

# Entra ID caseworker account credentials
ENTRA_ID_WRITER_USER=
ENTRA_ID_USER_PASSWORD=

# GAS bearer token (required)
GAS_BEARER_TOKEN=

# Local only: ephemeral-protected gateway URL for GAS (omit in CDP)
GAS_BASE_URL=ephemeral-protected.api.perf-test.cdp-int.defra.cloud/fg-gas-backend

# Local only: your developer x-api-key for the ephemeral-protected gateway (omit in CDP)
GAS_API_KEY=

# Optional overrides
# CW_FRONTEND_BASE_URL=fg-cw-frontend.perf-test.cdp-int.defra.cloud
# CW_ASSIGNED_USER_ID=
# WOODLAND_CONFIG_VERSION=
```

### 3. Seed applicant data

Applicant data (real CRNs/SBIs) must not be committed to the repo. Obtain `src/data/real-crns-must-not-add-to-git.json` from a team member or the CDP secret store, place it in `src/data/`, then run:

```bash
npm run seed-data
```

This reads the first 100 entries and writes `src/data/frps-applicants.json` in the format expected by k6. Both files are gitignored.

### 4. Generate CW session cookies

```bash
npm run generate-cookies
```

Writes `src/data/frps-session-cookies.csv`. Regenerate whenever sessions expire.

### 5. Create the reports directory

```bash
mkdir -p reports
```

---

## CDP setup

Configure the following secrets in the CDP Portal for the `perf-test` environment:

| Secret | Value |
|--------|-------|
| `ENTRA_ID_WRITER_USER` | Caseworker Entra account email |
| `ENTRA_ID_USER_PASSWORD` | Caseworker Entra account password |
| `GAS_BEARER_TOKEN` | GAS bearer token for perf-test |
| `FRPS_APPLICANTS_JSON` | Base64-encoded applicant JSON (see below) |

**Generating `FRPS_APPLICANTS_JSON`:** After running `npm run seed-data` locally, run:

```bash
node -e "console.log(Buffer.from(JSON.stringify(JSON.parse(require('fs').readFileSync('src/data/frps-applicants.json','utf8')))).toString('base64'))"
```

Paste the output as the `FRPS_APPLICANTS_JSON` secret value. The entrypoint decodes it at container startup before k6 runs. No `GAS_BASE_URL` or `GAS_API_KEY` are needed in CDP — the scenarios default to the direct perf-test service URL.

---

## Running locally

```bash
# FRPS full journey (1 hour)
npm run k6:frps

# WMP full journey (1 hour)
npm run k6:wmp
```

---

## Quick run (smoke test)

Runs for 5 minutes with 2 VUs — useful for verifying the setup before a full run.

```bash
npm run k6:frps:quick
npm run k6:wmp:quick
```

---

## Build

Test suites are built automatically by the [.github/workflows/publish.yml](.github/workflows/publish.yml) action whenever a change is committed to the `main` branch.

---

## CDP Squid Proxy — Required Domain Allowlist

The CDP squid proxy blocks all outbound traffic by default. The Microsoft Entra ID login flow requires access to CDN domains that are not on the default allowlist. Without these, the browser-based login form will never render.

Add the following to `cdp-tenant-config/environments/perf-test/squid/core-services-performance-tests.json`:

```json
{
  "allowed_ports": [],
  "allowed_domains": [
    "aadcdn.msauth.net",
    "aadcdn.msftauth.net",
    "www.office.com",
    "login.live.com"
  ]
}
```

`login.microsoftonline.com` is already on the CDP default allowlist and does not need to be added.

Raise a PR against `cdp-tenant-config` and post the link in `#cdp-support` on Slack for the platform team to review and deploy.

---

## WMP Full Journey — Prerequisites & Gotchas

### What the script does

`src/scenarios/wmp-full-journey.js` runs a full end-to-end WMP (Woodland Management Plan) journey:

1. **Submit WMP application** to GAS (`POST /grants/woodland/applications`)
2. **Poll** for the CW case to be created (async SNS/SQS delay)
3. **CW caseworker login** (via session cookies from CSV)
4. **Assign case** to the perf-test caseworker
5. **ACTION_START_REVIEW** → STATUS_APPLICATION_IN_REVIEW
6. **Approve application** → STATUS_AGREEMENT_GENERATING
7. **Wait** for CW case to transition STATUS_AGREEMENT_GENERATING → STATUS_AGREEMENT_READY_FOR_APPLICANT
8. **Complete agreement delivery task**: TASK_AGREEMENT_DELIVERY_TO_APPLICANT
9. **ACTION_CONFIRM_AGREEMENT_SENT** → STATUS_AGREEMENT_WITH_CUSTOMER
10. **Accept agreement** via GAS: `GET /agreements/current` → `POST /agreements/{number}/actions/accept`
11. **CRM record task**: TASK_CRM_RECORD_CREATION
12. **ACTION_FORWARD_TO_FC**
13. **FC review task**: TASK_FC_REVIEW_OUTCOME
14. **ACTION_APPROVE_FC_REVIEW**
15. **Claim prep tasks**: TASK_RECORD_ELIGIBLE_AREA, TASK_NOTIFY_READY_TO_CLAIM
16. **ACTION_CLAIM_PREP_COMPLETE**

### Check the deployed grants-config-woodland version

Before running, verify the version of `grants-config-woodland` deployed to perf-test:

- CDP Portal → Services → grants-config-woodland → check the deployed tag

Then update `WOODLAND_CONFIG_VERSION` in `.env` if it differs from the default in `wmp-full-journey.js`:

```js
const WOODLAND_CONFIG_VERSION = __ENV.WOODLAND_CONFIG_VERSION || '1.43.1'; // ← update this
```

**Why this matters:** The WMP application submit payload uses this version as `configVersion`. GAS resolves the grant config by major version — if the version here is in a different major (e.g. `0.x.x` vs `1.x.x`) from what is registered in perf-test, agreement generation will fail.

### Key gotchas

| Issue | Root cause | Fix |
|-------|-----------|-----|
| `"Agreement definition 'woodland' version 'X.Y.Z' is unavailable"` | `configVersion` in submit payload resolves to wrong major in GAS config catalog | Set `WOODLAND_CONFIG_VERSION` to match deployed grants-config-woodland tag |
| Agreement generation never completes (STATUS_AGREEMENT_GENERATING loops forever) | `configVersion` wrong major | Same fix as above |
| `gzip: invalid header` on GAS requests (status=0 in k6) | k6 can't decompress gzip response from GAS | `'Accept-Encoding': 'identity'` in all GAS request headers |
| `412 Agreement version is stale` on accept | GAS async processing updates agreement version between GET and POST | Script re-fetches ETag and retries once automatically |
| `ACTION_CONFIRM_AGREEMENT_SENT` returns 400 | Case still in STATUS_AGREEMENT_GENERATING when script tries to proceed | Script polls for `TASK_AGREEMENT_DELIVERY_TO_APPLICANT` in CW case page body before continuing |
| `open reports/index.html: no such file or directory` | Reports directory not created | Run `mkdir -p reports` before running k6 |

---

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government licence v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
