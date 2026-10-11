/**
 * WMP Full Journey
 *
 * Combines WMP application submission and the complete CW caseworker review in a
 * single end-to-end scenario. Each VU submits its own fresh WMP application to
 * GAS, polls CW until the case is created (async via SNS/SQS), then walks the
 * full caseworker journey through to agreement confirmed sent.
 *
 * Journey phases:
 *   1. Submit WMP application to GAS (POST → 204)
 *   2. Poll CW frontend until case appears (GET /cases?search=<clientRef>)
 *   3. Open case page
 *   4. Assign case to caseworker (GET + POST /cases/assign-user)
 *   5. Start review (POST /cases/:id/stage/outcome → actionCode=ACTION_START_REVIEW)
 *   6. Approve application (POST → actionCode=ACTION_APPROVE_APPLICATION)
 *   7. Agreement delivery task (TASK_GROUP_AGREEMENT_PREPARATION / TASK_AGREEMENT_DELIVERY_TO_APPLICANT)
 *   8. Confirm agreement sent (POST → actionCode=ACTION_CONFIRM_AGREEMENT_SENT)
 *   9. Browse case tabs (case-details, agreements, timeline, notes)
 *
 * Key implementation notes:
 *   - Session is loaded from CSV into k6's cookie jar at VU start. k6 then sends
 *     it automatically with every CW request and updates it from Set-Cookie
 *     responses — exactly like a browser. No explicit Cookie header is used.
 *   - All POSTs use redirects: 0 so we can verify the 302 response directly.
 *
 * Pre-conditions:
 *   - frps-session-cookies.csv must contain valid CW frontend session cookies
 *     (generate with: npm run generate-cookies)
 *   - frps-applicants.json must contain test applicants with sbi/crn/organisationId/name/firstName/lastName
 *
 * Environment variables (all optional — defaults work for CDP perf-test):
 *   GAS_BASE_URL        Local only: ephemeral-protected.api.perf-test.cdp-int.defra.cloud/fg-gas-backend
 *                       If unset, uses CDP direct URL automatically.
 *   GAS_API_KEY         Local only: your developer API key. Not required in CDP (omit entirely).
 *   GAS_BEARER_TOKEN    Fixed bearer token. Defaults to perf-test value.
 *   CW_FRONTEND_BASE_URL  Defaults to perf-test CW frontend URL.
 *   CW_ASSIGNED_USER_ID   Defaults to perf-test caseworker ID.
 *
 * Login used: SA-FGCW.WRITER@defra.onmicrosoft.com (session cookie from CSV).
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { assertStatus } from '../lib/checks.js';
import { handleSummary } from '../lib/report.js';

export { handleSummary };

// GAS URL resolves automatically:
//   Local:  set GAS_BASE_URL=ephemeral-protected.api.perf-test.cdp-int.defra.cloud/fg-gas-backend
//   CDP:    leave GAS_BASE_URL unset — defaults to direct service URL
const GAS_URL = __ENV.GAS_BASE_URL
  ? `https://${__ENV.GAS_BASE_URL}`
  : 'https://fg-gas-backend.perf-test.cdp-int.defra.cloud';

// API key: local only — set GAS_API_KEY to your developer key. Not needed in CDP.
const GAS_API_KEY = __ENV.GAS_API_KEY || null;

// Fixed bearer token — same value everywhere
const GAS_BEARER_TOKEN = __ENV.GAS_BEARER_TOKEN || '99731eaa-43e6-44fe-a18c-25385c1a3a93';

const CW_FRONTEND_URL = `https://${__ENV.CW_FRONTEND_BASE_URL || 'fg-cw-frontend.perf-test.cdp-int.defra.cloud'}`;
const ASSIGNED_USER_ID = __ENV.CW_ASSIGNED_USER_ID || '69c2749c461dcb042523bd16';

// Max time to wait for GAS → CW async case creation before giving up
const CASE_POLL_TIMEOUT_S = 300;
const CASE_POLL_INTERVAL_S = 5;

const sessionCookies = new SharedArray('wmp-session-cookies', () =>
  open('../data/frps-session-cookies.csv')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((line) => line.trim()),
);

const applicants = new SharedArray('wmp-applicants', () =>
  JSON.parse(open('../data/frps-applicants.json')),
);

export const options = {
  scenarios: {
    wmp_full_journey: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 5 },
        { duration: '3m', target: 5 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    // Overall
    http_req_duration: ['p(95)<5000'],
    http_req_failed: ['rate<0.05'],
    errors: ['rate<0.05'],

    // Per-transaction — appear as individual rows in the report
    'http_req_duration{name:SubmitWmpApplication}':          ['p(95)<3000'],
    'http_req_duration{name:GetCase}':                       ['p(95)<3000'],
    'http_req_duration{name:GetAssignUser}':                 ['p(95)<3000'],
    'http_req_duration{name:PostAssignUser}':                ['p(95)<3000'],
    'http_req_duration{name:PostStartReview}':               ['p(95)<3000'],
    'http_req_duration{name:PostApproveApplication}':        ['p(95)<3000'],
    'http_req_duration{name:GetAgreementDeliveryTask}':      ['p(95)<3000'],
    'http_req_duration{name:PostAgreementDeliveryTask}':     ['p(95)<3000'],
    'http_req_duration{name:PostConfirmAgreementSent}':      ['p(95)<3000'],
    'http_req_duration{name:GetCaseDetails}':                ['p(95)<3000'],
    'http_req_duration{name:GetAgreements}':                 ['p(95)<3000'],
    'http_req_duration{name:GetTimeline}':                   ['p(95)<3000'],
    'http_req_duration{name:GetNotes}':                      ['p(95)<3000'],
  },
};

// ── Headers ───────────────────────────────────────────────────────────────────

const gasHeaders = () => {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${GAS_BEARER_TOKEN}`,
  };
  if (GAS_API_KEY) headers['x-api-key'] = GAS_API_KEY;
  return headers;
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// No explicit Cookie header — session is managed via k6's cookie jar (set at VU
// start from the CSV, then automatically updated from Set-Cookie responses).
// This prevents the duplicate-cookie problem that arises when both an explicit
// Cookie header and a jar-captured cookie exist for the same name.

const cwBrowserHeaders = () => ({
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'upgrade-insecure-requests': '1',
});

const cwFormHeaders = (referer) => ({
  'User-Agent': UA,
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  Origin: CW_FRONTEND_URL,
  Referer: referer || CW_FRONTEND_URL,
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
});

// ── Logging helpers ───────────────────────────────────────────────────────────

function logStep(label, res, fullBody) {
  const location = res.headers['Location'] ? ` → ${res.headers['Location']}` : '';
  console.log(`[VU=${__VU}] ${label} | status=${res.status}${location}`);
  if (res.body && res.body.length > 0) {
    const limit = fullBody ? res.body.length : 500;
    const snippet = res.body.length > limit ? res.body.substring(0, limit) + '...(truncated)' : res.body;
    console.log(`[VU=${__VU}] ${label} | body=${snippet}`);
  }
}

// ── GAS submission ────────────────────────────────────────────────────────────

function submitApplication(clientRef, applicant) {
  const submittedAt = new Date().toISOString();

  const payload = JSON.stringify({
    metadata: {
      clientRef,
      configVersion: '0.2.0',
      sbi: String(applicant.sbi),
      frn: '1234567890',
      crn: String(applicant.crn),
      submittedAt,
    },
    answers: {
      businessDetailsUpToDate: true,
      guidanceRead: true,
      landRegisteredWithRpa: true,
      landManagementControl: true,
      publicBodyTenant: false,
      landHasGrazingRights: false,
      appLandHasExistingWmp: false,
      intendToApplyHigherTier: false,
      includedAllEligibleWoodland: true,
      applicationConfirmation: true,
      totalHectaresForSelectedParcels: 10,
      totalAgreementPaymentPence: 166200,
      payments: {
        agreement: [
          {
            code: 'PA3',
            description: 'Woodland management plan',
            activePaymentTier: 2,
            quantityInActiveTier: 5.4,
            activeTierRatePence: 3000,
            activeTierFlatRatePence: 150000,
            quantity: 55.4,
            agreementTotalPence: 166200,
            unit: 'ha',
          },
        ],
      },
      hectaresTenOrOverYearsOld: 6,
      hectaresUnderTenYearsOld: 4,
      woodlandName: 'Test Woodland',
      centreGridReference: 'SK512347',
      fcTeamCode: 'SOUTH_WEST',
      landParcels: [{ parcelId: 'NT8701-9412', areaHa: 10.0 }],
      applicant: {
        business: {
          name: applicant.name,
          reference: String(applicant.organisationId),
          email: `perf-test+${applicant.sbi}@example.test`,
          phone: '02011223344',
          address: {
            line1: '1 Moorfield',
            line2: 'Glossop',
            line3: null,
            line4: null,
            line5: null,
            street: '1 Moorfield',
            city: 'Chesham',
            postalCode: 'SK13 5CB',
          },
        },
        customer: {
          name: {
            title: 'Mr',
            first: applicant.firstName,
            middle: null,
            last: applicant.lastName,
          },
        },
      },
    },
  });

  const url = `${GAS_URL}/grants/woodland/applications`;
  console.log(`[VU=${__VU}] POST ${url} | clientRef=${clientRef} sbi=${applicant.sbi} crn=${applicant.crn}`);

  const res = http.post(url, payload, {
    headers: gasHeaders(),
    tags: { name: 'SubmitWmpApplication' },
  });

  logStep('SubmitWmpApplication', res);
  return assertStatus(res, 204, 'Submit WMP application');
}

// ── Case polling ──────────────────────────────────────────────────────────────

/**
 * Polls GET /cases?search=:clientRef on the CW frontend (HTML) until the case appears.
 * Returns caseId string or null if timeout exceeded.
 */
function waitForCase(clientRef) {
  const deadline = Date.now() + CASE_POLL_TIMEOUT_S * 1000;
  const url = `${CW_FRONTEND_URL}/cases?search=${clientRef}`;
  const caseIdPattern = /\/cases\/([a-f0-9]{24})/;

  console.log(`[VU=${__VU}] Polling ${url} every ${CASE_POLL_INTERVAL_S}s (timeout=${CASE_POLL_TIMEOUT_S}s)`);

  while (Date.now() < deadline) {
    const res = http.get(url, {
      headers: cwBrowserHeaders(),
      redirects: 5,
      tags: { name: 'PollCaseSearch' },
    });

    console.log(`[VU=${__VU}] PollCaseSearch status=${res.status} url=${res.url}`);

    // Detect session expiry — redirected to Microsoft login
    if (res.url && res.url.indexOf('login.microsoftonline.com') !== -1) {
      console.error(`[VU=${__VU}] SESSION EXPIRED — redirected to Microsoft login. Regenerate session cookie and retry.`);
      return null;
    }

    if (res.status === 200) {
      const match = res.body.match(caseIdPattern);
      if (match) {
        console.log(`[VU=${__VU}] Found case [clientRef=${clientRef}] → caseId=${match[1]}`);
        return match[1];
      }
      const snippet = res.body.length > 800 ? res.body.substring(0, 800) : res.body;
      console.log(`[VU=${__VU}] No caseId yet. Snippet: ${snippet}`);
    } else {
      console.warn(`[VU=${__VU}] Unexpected status=${res.status} body=${res.body.substring(0, 300)}`);
    }

    sleep(CASE_POLL_INTERVAL_S);
  }

  console.warn(`[VU=${__VU}] Timed out waiting for case [clientRef=${clientRef}]`);
  return null;
}

// ── Main scenario ─────────────────────────────────────────────────────────────

export default function () {
  // Seed k6's cookie jar with the session cookie from CSV.
  // k6 will then automatically send it with every request to CW_FRONTEND_URL
  // and update it whenever the server issues a new Set-Cookie — exactly like a browser.
  const cookieLine = sessionCookies[__VU % sessionCookies.length];
  const sessionValue = cookieLine.replace(/^session=/, '');
  const jar = http.cookieJar();
  jar.clear(CW_FRONTEND_URL);
  jar.set(CW_FRONTEND_URL, 'session', sessionValue);

  const applicant = applicants[__VU % applicants.length];
  const runId = Math.floor(Date.now() / 1000);
  const clientRef = `wmp-perf-${runId}-${__VU}-${__ITER}`;

  console.log(`[VU=${__VU}] === Starting WMP full journey | clientRef=${clientRef} sbi=${applicant.sbi} crn=${applicant.crn} name="${applicant.name}" ===`);
  console.log(`[VU=${__VU}] GAS_URL=${GAS_URL} CW_FRONTEND_URL=${CW_FRONTEND_URL}`);
  console.log(`[VU=${__VU}] Session (first 60 chars): ${sessionValue ? sessionValue.substring(0, 60) : 'MISSING'}...`);

  // ── Phase 1: Submit application to GAS ──────────────────────────────────────
  if (!submitApplication(clientRef, applicant)) {
    console.error(`[VU=${__VU}] FAILED at Phase 1: GAS application submission`);
    return;
  }
  console.log(`[VU=${__VU}] Phase 1 complete: WMP application submitted clientRef=${clientRef}`);

  // Simulate application sitting in the queue before a caseworker picks it up
  console.log(`[VU=${__VU}] Think time: application submitted — waiting 120s before caseworker picks it up`);
  sleep(120);

  // ── Phase 2: Wait for case to appear in CW (async GAS→CW via SNS/SQS) ──────
  console.log(`[VU=${__VU}] Phase 2: Polling CW for case (timeout=${CASE_POLL_TIMEOUT_S}s interval=${CASE_POLL_INTERVAL_S}s)`);
  const caseId = waitForCase(clientRef);
  if (!caseId) {
    console.error(`[VU=${__VU}] FAILED at Phase 2: Case never appeared in CW for clientRef=${clientRef}`);
    return;
  }
  console.log(`[VU=${__VU}] Phase 2 complete: caseId=${caseId}`);

  // ── Phase 3: Open case ───────────────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 3: Opening case ${caseId}`);
  logStep('GetCase', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCase' },
  }));
  sleep(5);

  // ── Phase 4: Assign case to caseworker ──────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 4: Assigning case ${caseId} to user ${ASSIGNED_USER_ID}`);
  const assignUrl = `${CW_FRONTEND_URL}/cases/assign-user?caseId=${caseId}`;

  logStep('GetAssignUser', http.get(assignUrl, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetAssignUser' },
  }));
  sleep(5);

  const postAssignRes = http.post(
    `${CW_FRONTEND_URL}/cases/assign-user`,
    'caseId=' + caseId + '&assignedUserId=' + ASSIGNED_USER_ID + '&notes=assign+the+case',
    {
      headers: cwFormHeaders(assignUrl),
      redirects: 0,
      tags: { name: 'PostAssignUser' },
    },
  );
  logStep('PostAssignUser', postAssignRes);
  if (postAssignRes.status !== 302) {
    console.warn(`[VU=${__VU}] AssignUser POST returned ${postAssignRes.status} (expected 302)`);
  }
  sleep(5);

  logStep('GetCaseAfterAssign', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterAssign' },
  }));
  sleep(10);

  // ── Phase 5: Start review ────────────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 5: Starting review for case ${caseId}`);
  const startReviewRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/stage/outcome`,
    'actionCode=ACTION_START_REVIEW',
    {
      headers: cwFormHeaders(`${CW_FRONTEND_URL}/cases/${caseId}`),
      redirects: 0,
      tags: { name: 'PostStartReview' },
    },
  );
  logStep('PostStartReview', startReviewRes, true);
  if (startReviewRes.status !== 302) {
    console.error(`[VU=${__VU}] FAILED: ACTION_START_REVIEW returned ${startReviewRes.status} (expected 302) — action not accepted`);
    return;
  }
  console.log(`[VU=${__VU}] Phase 5 complete: ACTION_START_REVIEW accepted`);
  sleep(10);

  logStep('GetCaseAfterStartReview', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterStartReview' },
  }));
  sleep(10);

  // ── Phase 6: Approve application ─────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 6: Approving application for case ${caseId}`);
  const approveRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/stage/outcome`,
    'actionCode=ACTION_APPROVE_APPLICATION&ACTION_RETURN_TO_CUSTOMER-comment=',
    {
      headers: cwFormHeaders(`${CW_FRONTEND_URL}/cases/${caseId}`),
      redirects: 0,
      tags: { name: 'PostApproveApplication' },
    },
  );
  logStep('PostApproveApplication', approveRes);
  if (approveRes.status !== 302) {
    console.warn(`[VU=${__VU}] ACTION_APPROVE_APPLICATION returned ${approveRes.status} (expected 302)`);
  }
  sleep(10);

  logStep('GetCaseAfterApproval', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterApproval' },
  }));
  sleep(10);

  // ── Phase 7: Agreement delivery task ─────────────────────────────────────────
  // Agreement has been generated — simulate it sitting there before caseworker reviews it
  console.log(`[VU=${__VU}] Think time: agreement generated — waiting 120s before caseworker reviews it`);
  sleep(120);

  console.log(`[VU=${__VU}] Phase 7: Completing agreement delivery task for case ${caseId}`);
  const taskGroup = 'TASK_GROUP_AGREEMENT_PREPARATION';
  const task = 'TASK_AGREEMENT_DELIVERY_TO_APPLICANT';
  const taskUrl = `${CW_FRONTEND_URL}/cases/${caseId}/tasks/${taskGroup}/${task}`;

  logStep('GetAgreementDeliveryTask', http.get(taskUrl, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetAgreementDeliveryTask' },
  }));
  sleep(15);

  const postTaskRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/task-groups/${taskGroup}/tasks/${task}/value`,
    'value=STATUS_AGREEMENT_SENT_TO_APPLICANT&STATUS_AGREEMENT_SENT_TO_APPLICANT-comment=' + encodeURIComponent('Notify customer that draft agreement is ready') + '&STATUS_AGREEMENT_NOT_SENT_TO_APPLICANT-comment=',
    {
      headers: cwFormHeaders(taskUrl),
      redirects: 0,
      tags: { name: 'PostAgreementDeliveryTask' },
    },
  );
  logStep('PostAgreementDeliveryTask', postTaskRes);
  if (postTaskRes.status !== 302) {
    console.warn(`[VU=${__VU}] ${task} POST returned ${postTaskRes.status} (expected 302)`);
  }
  sleep(15);

  logStep('GetCaseAfterAgreementTask', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterAgreementTask' },
  }));
  sleep(10);

  // ── Phase 8: Confirm agreement sent ──────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 8: Confirming agreement sent for case ${caseId}`);
  const confirmSentRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/stage/outcome`,
    'actionCode=ACTION_CONFIRM_AGREEMENT_SENT&ACTION_CONFIRM_AGREEMENT_SENT-comment=' + encodeURIComponent('Agreement ready for applicant'),
    {
      headers: cwFormHeaders(`${CW_FRONTEND_URL}/cases/${caseId}`),
      redirects: 0,
      tags: { name: 'PostConfirmAgreementSent' },
    },
  );
  logStep('PostConfirmAgreementSent', confirmSentRes);
  if (confirmSentRes.status !== 302) {
    console.warn(`[VU=${__VU}] ACTION_CONFIRM_AGREEMENT_SENT returned ${confirmSentRes.status} (expected 302)`);
  }
  sleep(10);

  logStep('GetCaseAfterConfirmSent', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterConfirmSent' },
  }));
  sleep(10);

  // ── Phase 9: Browse case tabs ─────────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 9: Browsing case tabs for case ${caseId}`);

  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/case-details`, { headers: cwBrowserHeaders(), tags: { name: 'GetCaseDetails' } });
  sleep(3);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/agreements`, { headers: cwBrowserHeaders(), tags: { name: 'GetAgreements' } });
  sleep(3);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/timeline`, { headers: cwBrowserHeaders(), tags: { name: 'GetTimeline' } });
  sleep(3);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/notes`, { headers: cwBrowserHeaders(), tags: { name: 'GetNotes' } });
  sleep(1);

  console.log(`[VU=${__VU}] === COMPLETE: WMP full journey finished | clientRef=${clientRef} caseId=${caseId} ===`);
}
