/**
 * FRPS Full Journey v2
 *
 * Combines application submission and the complete CW caseworker review in a
 * single end-to-end scenario. Each VU submits its own fresh FRPS application
 * to GAS, polls CW until the case is created (async via SNS/SQS), then walks
 * the full caseworker journey through to agreement sent.
 *
 * Journey phases:
 *   1. Submit FRPS application to GAS (POST → 204)
 *   2. Poll CW frontend until case appears (GET /cases?search=<clientRef>)
 *   3. Open case page
 *   4. Assign case to caseworker (GET + POST /cases/assign-user)
 *   5. Start review (POST /cases/:id/stage/outcome → actionCode=START_REVIEW)
 *   6. Manual review tasks (all ACCEPTED):
 *        CHECK_CUSTOMER_DETAILS
 *        REVIEW_LAND_RULES
 *        SSSI_CONSENT_REQUESTED
 *        PAYMENT_AMOUNT_CHECK
 *        REVIEW_SCHEME_BUDGET
 *   7. Approve application (POST → actionCode=APPROVE_APPLICATION)
 *   8. Draft agreement review tasks (all CONFIRM):
 *        REVIEW_OFFER_DOCUMENT
 *        OFFER_AGREEMENT
 *   9. Agreement sent (POST → actionCode=AGREEMENT_SENT)
 *  10. Browse case tabs (case-details, calculations, timeline, notes, agreements)
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

const sessionCookies = new SharedArray('frps-session-cookies', () =>
  open('../data/frps-session-cookies.csv')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((line) => line.trim()),
);

const applicants = new SharedArray('frps-applicants', () =>
  JSON.parse(open('../data/frps-applicants.json')),
);

export const options = {
  scenarios: {
    frps_full_journey: {
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
    'http_req_duration{name:SubmitApplication}':              ['p(95)<3000'],
    'http_req_duration{name:GetCase}':                        ['p(95)<3000'],
    'http_req_duration{name:GetAssignUser}':                  ['p(95)<3000'],
    'http_req_duration{name:PostAssignUser}':                 ['p(95)<3000'],
    'http_req_duration{name:PostStartReview}':                ['p(95)<3000'],
    'http_req_duration{name:PostTask_CHECK_CUSTOMER_DETAILS}':['p(95)<3000'],
    'http_req_duration{name:PostTask_REVIEW_LAND_RULES}':     ['p(95)<3000'],
    'http_req_duration{name:PostTask_SSSI_CONSENT_REQUESTED}':['p(95)<3000'],
    'http_req_duration{name:PostTask_PAYMENT_AMOUNT_CHECK}':  ['p(95)<3000'],
    'http_req_duration{name:PostTask_REVIEW_SCHEME_BUDGET}':  ['p(95)<3000'],
    'http_req_duration{name:PostApproveApplication}':         ['p(95)<3000'],
    'http_req_duration{name:PostTask_REVIEW_OFFER_DOCUMENT}': ['p(95)<3000'],
    'http_req_duration{name:PostTask_OFFER_AGREEMENT}':       ['p(95)<3000'],
    'http_req_duration{name:PostAgreementSent}':              ['p(95)<3000'],
    'http_req_duration{name:GetCaseDetails}':                 ['p(95)<3000'],
    'http_req_duration{name:GetCalculations}':                ['p(95)<3000'],
    'http_req_duration{name:GetTimeline}':                    ['p(95)<3000'],
    'http_req_duration{name:GetNotes}':                       ['p(95)<3000'],
    'http_req_duration{name:GetAgreements}':                  ['p(95)<3000'],
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
  const payload = JSON.stringify({
    metadata: {
      clientRef,
      sbi: String(applicant.sbi),
      frn: '1234567890',
      crn: String(applicant.crn),
      submittedAt: '2025-03-28T11:30:52.000Z',
      configVersion: '1.0.0',
    },
    answers: {
      rulesCalculations: {
        id: 2979,
        message: 'Application validated successfully',
        valid: true,
        date: '2025-03-28T11:30:52.000Z',
        caveats: [
          {
            code: 'ne-consent-required',
            description: 'A consent is required from Natural England',
            metadata: {
              actionCode: 'UPL1',
              parcelId: '7656',
              sheetId: 'SD6352',
              percentageOverlap: 2.14,
              overlapAreaHectares: 0.0336,
            },
          },
        ],
      },
      scheme: 'SFI',
      applicant: {
        business: {
          reference: String(applicant.organisationId),
          email: 'perf-test@example.com.test',
          mobilePhoneNumber: '07700900000',
          landlinePhoneNumber: '01235000000',
          name: applicant.name,
          address: {
            line1: 'Benbrigge House - line 1',
            line2: 'ALBRIGHTON - line 2',
            line3: 'Cuckoo Hill Farm - line 3',
            line4: 'Cuckoo Hill Farm -line 4',
            line5: 'Farm road -line 5',
            street: 'BRIDGE ROAD - Street',
            city: 'GRIMSBY - City',
            postalCode: 'DY13 0UY',
          },
        },
        customer: {
          name: { title: 'Mr', first: applicant.firstName, middle: '', last: applicant.lastName },
        },
      },
      totalAnnualPaymentPence: 70284,
      application: {
        parcel: [
          {
            sheetId: 'SK0971',
            parcelId: '7555',
            area: { unit: 'ha', quantity: 5.2182 },
            actions: [
              { code: 'CMOR1', version: '1', durationYears: 3, appliedFor: { unit: 'ha', quantity: 4.7575 } },
              { code: 'UPL3', version: '1', durationYears: 3, appliedFor: { unit: 'ha', quantity: 4.7575 } },
            ],
          },
          {
            sheetId: 'SK0971',
            parcelId: '9194',
            area: { unit: 'ha', quantity: 2.1703 },
            actions: [
              { code: 'CMOR1', version: '1', durationYears: 3, appliedFor: { unit: 'ha', quantity: 2.1705 } },
              { code: 'UPL1', version: '1', durationYears: 3, appliedFor: { unit: 'ha', quantity: 2.1705 } },
            ],
          },
        ],
        agreement: [],
      },
      payments: {
        parcel: [
          {
            sheetId: 'SK0971',
            parcelId: '7555',
            area: { unit: 'ha', quantity: 5.2182 },
            actions: [
              { code: 'CMOR1', description: 'Assess moorland and produce a written record', durationYears: 3, paymentRates: 1060, annualPaymentPence: 5042, eligible: { unit: 'ha', quantity: 4.7575 }, appliedFor: { unit: 'ha', quantity: 4.7575 } },
              { code: 'UPL3', description: 'Limited livestock grazing on moorland', durationYears: 3, paymentRates: 6600, annualPaymentPence: 31399, eligible: { unit: 'ha', quantity: 4.7575 }, appliedFor: { unit: 'ha', quantity: 4.7575 } },
            ],
          },
          {
            sheetId: 'SK0971',
            parcelId: '9194',
            area: { unit: 'ha', quantity: 2.1703 },
            actions: [
              { code: 'CMOR1', description: 'Assess moorland and produce a written record', durationYears: 3, paymentRates: 1060, annualPaymentPence: 2300, eligible: { unit: 'ha', quantity: 2.1705 }, appliedFor: { unit: 'ha', quantity: 2.1705 } },
              { code: 'UPL1', description: 'Moderate livestock grazing on moorland', durationYears: 3, paymentRates: 2000, annualPaymentPence: 4341, eligible: { unit: 'ha', quantity: 2.1705 }, appliedFor: { unit: 'ha', quantity: 2.1705 } },
            ],
          },
        ],
        agreement: [
          { code: 'CMOR1', description: 'Assess moorland and produce a written record', durationYears: 3, paymentRates: 27200, annualPaymentPence: 27200 },
        ],
      },
    },
  });

  const url = `${GAS_URL}/grants/frps-private-beta/applications`;
  console.log(`[VU=${__VU}] POST ${url} | clientRef=${clientRef} sbi=${applicant.sbi} crn=${applicant.crn}`);

  const res = http.post(url, payload, {
    headers: gasHeaders(),
    tags: { name: 'SubmitApplication' },
  });

  logStep('SubmitApplication', res);
  return assertStatus(res, 204, 'Submit application');
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

// ── Task helpers ──────────────────────────────────────────────────────────────

/**
 * Completes a MANUAL_REVIEW_TASKS task with ACCEPTED outcome.
 */
function completeManualTask(caseId, task, comment) {
  console.log(`[VU=${__VU}] completeManualTask: MANUAL_REVIEW_TASKS/${task}`);
  const taskUrl = `${CW_FRONTEND_URL}/cases/${caseId}/tasks/MANUAL_REVIEW_TASKS/${task}`;

  logStep('GetTask_' + task, http.get(taskUrl, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetTask_' + task },
  }));
  sleep(3);

  const postRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/task-groups/MANUAL_REVIEW_TASKS/tasks/${task}/value`,
    'value=ACCEPTED&ACCEPTED-comment=' + encodeURIComponent(comment) + '&RFI-comment=&INTERNAL_INVESTIGATION-comment=&CANNOT_COMPLETE-comment=',
    {
      headers: cwFormHeaders(taskUrl),
      redirects: 0,
      tags: { name: 'PostTask_' + task },
    },
  );
  logStep('PostTask_' + task, postRes);
  if (postRes.status !== 302) {
    console.warn(`[VU=${__VU}] Task ${task} POST returned ${postRes.status} (expected 302)`);
  }
}

/**
 * Completes a DRAFT_AGREEMENT_REVIEW_TASKS task with CONFIRM outcome.
 */
function completeAgreementTask(caseId, task, comment) {
  console.log(`[VU=${__VU}] completeAgreementTask: DRAFT_AGREEMENT_REVIEW_TASKS/${task}`);
  const taskUrl = `${CW_FRONTEND_URL}/cases/${caseId}/tasks/DRAFT_AGREEMENT_REVIEW_TASKS/${task}`;

  logStep('GetTask_' + task, http.get(taskUrl, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetTask_' + task },
  }));
  sleep(3);

  const postRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/task-groups/DRAFT_AGREEMENT_REVIEW_TASKS/tasks/${task}/value`,
    'value=CONFIRM&CONFIRM-comment=' + encodeURIComponent(comment) + '&PROBLEM_FOUND-comment=',
    {
      headers: cwFormHeaders(taskUrl),
      redirects: 0,
      tags: { name: 'PostTask_' + task },
    },
  );
  logStep('PostTask_' + task, postRes);
  if (postRes.status !== 302) {
    console.warn(`[VU=${__VU}] Task ${task} POST returned ${postRes.status} (expected 302)`);
  }
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
  const clientRef = `frps-perf-${runId}-${__VU}-${__ITER}`;

  console.log(`[VU=${__VU}] === Starting FRPS full journey v2 | clientRef=${clientRef} sbi=${applicant.sbi} crn=${applicant.crn} name="${applicant.name}" ===`);
  console.log(`[VU=${__VU}] GAS_URL=${GAS_URL} CW_FRONTEND_URL=${CW_FRONTEND_URL}`);
  console.log(`[VU=${__VU}] Session (first 60 chars): ${sessionValue ? sessionValue.substring(0, 60) : 'MISSING'}...`);

  // ── Phase 1: Submit application to GAS ──────────────────────────────────────
  if (!submitApplication(clientRef, applicant)) {
    console.error(`[VU=${__VU}] FAILED at Phase 1: GAS application submission`);
    return;
  }
  console.log(`[VU=${__VU}] Phase 1 complete: application submitted clientRef=${clientRef}`);

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
    'actionCode=START_REVIEW',
    {
      headers: cwFormHeaders(`${CW_FRONTEND_URL}/cases/${caseId}`),
      redirects: 0,
      tags: { name: 'PostStartReview' },
    },
  );
  logStep('PostStartReview', startReviewRes, true);
  if (startReviewRes.status !== 302) {
    console.error(`[VU=${__VU}] FAILED: START_REVIEW returned ${startReviewRes.status} (expected 302) — action not accepted`);
    return;
  }
  console.log(`[VU=${__VU}] Phase 5 complete: START_REVIEW accepted`);
  sleep(10);

  logStep('GetCaseAfterStartReview', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterStartReview' },
  }));
  sleep(10);

  // ── Phase 6: Manual review tasks ─────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 6: Completing manual review tasks for case ${caseId}`);

  completeManualTask(caseId, 'CHECK_CUSTOMER_DETAILS', 'Check customer details');
  sleep(15);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, { headers: cwBrowserHeaders(), tags: { name: 'GetCaseAfterCustDetails' } });
  sleep(10);

  completeManualTask(caseId, 'REVIEW_LAND_RULES', 'Review land parcel rule checks');
  sleep(15);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, { headers: cwBrowserHeaders(), tags: { name: 'GetCaseAfterLandRules' } });
  sleep(10);

  completeManualTask(caseId, 'SSSI_CONSENT_REQUESTED', 'Check notice of planned activity for SSSI has been requested');
  sleep(15);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, { headers: cwBrowserHeaders(), tags: { name: 'GetCaseAfterSSSI' } });
  sleep(10);

  completeManualTask(caseId, 'PAYMENT_AMOUNT_CHECK', 'Check payment amount');
  sleep(15);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, { headers: cwBrowserHeaders(), tags: { name: 'GetCaseAfterPaymentCheck' } });
  sleep(10);

  completeManualTask(caseId, 'REVIEW_SCHEME_BUDGET', 'Review scheme budget as a finance officer');
  sleep(15);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, { headers: cwBrowserHeaders(), tags: { name: 'GetCaseAfterSchemeBudget' } });
  sleep(10);

  // ── Phase 7: Approve application ─────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 7: Approving application for case ${caseId}`);
  const approveRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/stage/outcome`,
    'actionCode=APPROVE_APPLICATION&APPROVE_APPLICATION-comment=Approve+the+application+after+completing+all+tasks&REJECT_APPLICATION-comment=&PUT_ON_HOLD-comment=&RETURN_TO_CUSTOMER-comment=&WITHDRAW_APPLICATION-comment=',
    {
      headers: cwFormHeaders(`${CW_FRONTEND_URL}/cases/${caseId}`),
      redirects: 0,
      tags: { name: 'PostApproveApplication' },
    },
  );
  logStep('PostApproveApplication', approveRes);
  if (approveRes.status !== 302) {
    console.warn(`[VU=${__VU}] APPROVE_APPLICATION returned ${approveRes.status} (expected 302)`);
  }
  sleep(10);

  http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterApproval' },
  });
  sleep(10);

  // ── Phase 8: Draft agreement review tasks ─────────────────────────────────────
  // Agreement has been generated — simulate it sitting there before caseworker reviews it
  console.log(`[VU=${__VU}] Think time: agreement generated — waiting 120s before caseworker reviews it`);
  sleep(120);

  console.log(`[VU=${__VU}] Phase 8: Completing draft agreement review tasks for case ${caseId}`);

  completeAgreementTask(caseId, 'REVIEW_OFFER_DOCUMENT', 'Check funding agreement');
  sleep(15);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, { headers: cwBrowserHeaders(), tags: { name: 'GetCaseAfterReviewOffer' } });
  sleep(10);

  completeAgreementTask(caseId, 'OFFER_AGREEMENT', 'Notify customer that agreement is ready');
  sleep(15);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, { headers: cwBrowserHeaders(), tags: { name: 'GetCaseAfterOfferAgreement' } });
  sleep(10);

  // ── Phase 9: Agreement sent ───────────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 9: Sending agreement for case ${caseId}`);
  const agreementSentRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/stage/outcome`,
    'actionCode=AGREEMENT_SENT&REJECT_APPLICATION-comment=&RETURN_TO_CUSTOMER-comment=&WITHDRAW_APPLICATION-comment=',
    {
      headers: cwFormHeaders(`${CW_FRONTEND_URL}/cases/${caseId}`),
      redirects: 0,
      tags: { name: 'PostAgreementSent' },
    },
  );
  logStep('PostAgreementSent', agreementSentRes);
  if (agreementSentRes.status !== 302) {
    console.warn(`[VU=${__VU}] AGREEMENT_SENT returned ${agreementSentRes.status} (expected 302)`);
  }
  sleep(10);

  http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterAgreementSent' },
  });
  sleep(10);

  // ── Phase 10: Browse case tabs ────────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 10: Browsing case tabs for case ${caseId}`);

  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/case-details`, { headers: cwBrowserHeaders(), tags: { name: 'GetCaseDetails' } });
  sleep(3);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/calculations`, { headers: cwBrowserHeaders(), tags: { name: 'GetCalculations' } });
  sleep(3);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/timeline`, { headers: cwBrowserHeaders(), tags: { name: 'GetTimeline' } });
  sleep(3);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/notes`, { headers: cwBrowserHeaders(), tags: { name: 'GetNotes' } });
  sleep(3);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/agreements`, { headers: cwBrowserHeaders(), tags: { name: 'GetAgreements' } });
  sleep(1);

  console.log(`[VU=${__VU}] === COMPLETE: FRPS full journey finished | clientRef=${clientRef} caseId=${caseId} ===`);
}
