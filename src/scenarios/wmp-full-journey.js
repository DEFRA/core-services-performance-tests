/**
 * WMP Full Journey
 *
 * Combines WMP application submission and the complete CW caseworker review in a
 * single end-to-end scenario. Each VU submits its own fresh WMP application to
 * GAS, polls CW until the case is created (async via SNS/SQS), then walks the
 * full caseworker journey through to agreement confirmed sent.
 *
 * Journey phases:
 *   1.  Submit WMP application to GAS (POST → 204)
 *   2.  Poll CW frontend until case appears (GET /cases?search=<clientRef>)
 *   3.  Open case page
 *   4.  Assign case to caseworker (GET + POST /cases/assign-user)
 *   5.  Start review (POST /cases/:id/stage/outcome → actionCode=ACTION_START_REVIEW)
 *   6.  Approve application (POST → actionCode=ACTION_APPROVE_APPLICATION)
 *   7.  Poll for STATUS_AGREEMENT_READY_FOR_APPLICANT; complete TASK_AGREEMENT_DELIVERY_TO_APPLICANT
 *   8.  Confirm agreement sent (POST → actionCode=ACTION_CONFIRM_AGREEMENT_SENT)
 *   9.  Browse case tabs (case-details, agreements, timeline, notes)
 *   10. Accept agreement via GAS (GET /agreements/current → POST /agreements/:n/actions/accept)
 *   11. CRM record task (TASK_GROUP_CRM_RECORD / TASK_CRM_RECORD_CREATION → STATUS_CRM_RECORD_CREATED)
 *   12. Forward to FC (POST → actionCode=ACTION_FORWARD_TO_FC)
 *   13. FC review task (TASK_GROUP_FC_REVIEW / TASK_FC_REVIEW_OUTCOME → STATUS_FC_REVIEW_SUCCESSFUL)
 *   14. Approve FC review (POST → actionCode=ACTION_APPROVE_FC_REVIEW)
 *   15. Browse agreements tab + case page
 *   16. Claim prep tasks (TASK_RECORD_ELIGIBLE_AREA → STATUS_RECORDED,
 *       TASK_NOTIFY_READY_TO_CLAIM → STATUS_NOTIFICATION_SENT)
 *   17. Claim prep complete (POST → actionCode=ACTION_CLAIM_PREP_COMPLETE)
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
 *   GAS_BEARER_TOKEN    Required bearer token from environment secrets.
 *   CW_FRONTEND_BASE_URL  Defaults to perf-test CW frontend URL.
 *   CW_ASSIGNED_USER_ID   Defaults to perf-test caseworker ID.
 *
 * Login used: configured Entra test account (fresh session cookie from CSV).
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { assertStatus } from '../lib/checks.js';
import { handleSummary } from '../lib/report.js';
import { requiredEnvironmentValue, parseSessionCookies } from '../lib/runtime-inputs.js';

export { handleSummary };

// GAS URL resolves automatically:
//   Local:  set GAS_BASE_URL=ephemeral-protected.api.perf-test.cdp-int.defra.cloud/fg-gas-backend
//   CDP:    leave GAS_BASE_URL unset — defaults to direct service URL
const GAS_URL = __ENV.GAS_BASE_URL
  ? `https://${__ENV.GAS_BASE_URL}`
  : 'https://fg-gas-backend.perf-test.cdp-int.defra.cloud';

// API key: local only — set GAS_API_KEY to your developer key. Not needed in CDP.
const GAS_API_KEY = __ENV.GAS_API_KEY || null;

// The bearer token is supplied through environment secrets.
const GAS_BEARER_TOKEN = requiredEnvironmentValue(__ENV, 'GAS_BEARER_TOKEN');

// Woodland agreement definition version published to perf-test S3.
// Update this when a new version is deployed to perf-test.
const WOODLAND_CONFIG_VERSION = __ENV.WOODLAND_CONFIG_VERSION || '1.43.1';

const CW_FRONTEND_URL = `https://${__ENV.CW_FRONTEND_BASE_URL || 'fg-cw-frontend.perf-test.cdp-int.defra.cloud'}`;
const ASSIGNED_USER_ID = __ENV.CW_ASSIGNED_USER_ID || '69c2749c461dcb042523bd16';

// Max time to wait for GAS → CW async case creation before giving up
const CASE_POLL_TIMEOUT_S = 300;
const CASE_POLL_INTERVAL_S = 5;

const sessionCookies = new SharedArray('wmp-session-cookies', () =>
  parseSessionCookies(open('../data/frps-session-cookies.csv')),
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
        { duration: '5m',  target: 5 },
        { duration: '50m', target: 5 },
        { duration: '5m',  target: 0 },
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
    'http_req_duration{name:PollAgreementReady}':            ['p(95)<3000'],
    'http_req_duration{name:CreateTestAgreement}':           ['p(95)<5000'],
    'http_req_duration{name:GetCurrentAgreement}':           ['p(95)<3000'],
    'http_req_duration{name:AcceptAgreement}':               ['p(95)<5000'],
    'http_req_duration{name:GetCrmRecordTask}':              ['p(95)<3000'],
    'http_req_duration{name:PostCrmRecordTask}':             ['p(95)<3000'],
    'http_req_duration{name:PostForwardToFc}':               ['p(95)<3000'],
    'http_req_duration{name:GetFcReviewTask}':               ['p(95)<3000'],
    'http_req_duration{name:PostFcReviewTask}':              ['p(95)<3000'],
    'http_req_duration{name:PostApproveFcReview}':           ['p(95)<3000'],
    'http_req_duration{name:GetRecordEligibleAreaTask}':     ['p(95)<3000'],
    'http_req_duration{name:PostRecordEligibleAreaTask}':    ['p(95)<3000'],
    'http_req_duration{name:GetNotifyReadyToClaimTask}':     ['p(95)<3000'],
    'http_req_duration{name:PostNotifyReadyToClaimTask}':    ['p(95)<3000'],
    'http_req_duration{name:PostClaimPrepComplete}':         ['p(95)<3000'],
  },
};

// ── Headers ───────────────────────────────────────────────────────────────────

const gasHeaders = () => {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
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

// UUID v4 — required as idempotency-key for agreement actions
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

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

// ── Agreement acceptance helpers ──────────────────────────────────────────────

/**
 * Creates or retrieves a WMP agreement via the GAS test endpoint.
 * Idempotent: returns the existing agreement if clientRef+code already exists.
 * Returns agreementNumber string or null on failure.
 */
function createOrGetTestAgreement(clientRef, applicant) {
  const url = `${GAS_URL}/api/test/agreements`;
  const payload = JSON.stringify({
    code: 'woodland',
    clientRef,
    currentConfigVersion: WOODLAND_CONFIG_VERSION,
    identifiers: { sbi: String(applicant.sbi) },
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
        agreement: [{
          code: 'PA3',
          description: 'Woodland management plan',
          activePaymentTier: 2,
          quantityInActiveTier: 5.4,
          activeTierRatePence: 3000,
          activeTierFlatRatePence: 150000,
          quantity: 55.4,
          agreementTotalPence: 166200,
          unit: 'ha',
        }],
      },
      hectaresTenOrOverYearsOld: 6,
      hectaresUnderTenYearsOld: 4,
      woodlandName: 'Test Woodland',
      centreGridReference: 'NG12345678',
      fcTeamCode: 'SOUTH_WEST',
      landParcels: [{ parcelId: 'AA0001-0001', areaHa: 10.0 }],
      applicant: {
        business: {
          name: applicant.name,
          reference: String(applicant.organisationId),
          email: `perf-test+${applicant.sbi}@example.test`,
          phone: '02011223344',
          address: {
            line1: '1 Test Lane', line2: 'Test Village',
            line3: null, line4: null, line5: null,
            street: '1 Test Lane', city: 'Exampleton', postalCode: 'ZZ99 5ZZ',
          },
        },
        customer: {
          name: { title: 'Mr', first: applicant.firstName, middle: null, last: applicant.lastName },
        },
      },
    },
  });

  const res = http.post(url, payload, {
    headers: gasHeaders(),
    tags: { name: 'CreateTestAgreement' },
  });
  logStep('CreateTestAgreement', res);

  if (res.status !== 201) {
    console.error(`[VU=${__VU}] CreateTestAgreement failed status=${res.status}`);
    return null;
  }
  const body = JSON.parse(res.body);
  const agreementNumber = body.agreementData && body.agreementData.agreementNumber;
  console.log(`[VU=${__VU}] Agreement ready: ${agreementNumber} state=${body.agreementData && body.agreementData.state}`);
  return agreementNumber;
}

/**
 * GET /agreements/current — returns { agreementNumber, etag } for the given
 * clientRef/sbi, or null on failure. ETag is required for the accept action.
 */
function getCurrentAgreement(clientRef, applicant) {
  const headers = Object.assign({}, gasHeaders(), {
    'x-agreement-code': 'woodland',
    'x-agreement-client-ref': clientRef,
    'x-agreement-sbi': String(applicant.sbi),
  });
  const res = http.get(`${GAS_URL}/agreements/current`, {
    headers,
    tags: { name: 'GetCurrentAgreement' },
  });
  logStep('GetCurrentAgreement', res);

  if (res.status !== 200) {
    console.error(`[VU=${__VU}] GetCurrentAgreement failed status=${res.status}`);
    return null;
  }
  const body = JSON.parse(res.body);
  const agreementNumber = body.agreement && body.agreement.agreementNumber;
  const version = body.agreement && body.agreement.version;

  // ETag header may be stripped by the CDP load balancer — construct it from body fields.
  // Format: "<agreementNumber>:<version>:<configVersion>" (quotes are part of the ETag value).
  let etag = res.headers['ETag'] || res.headers['etag'] || res.headers['Etag'];
  if (!etag && agreementNumber && version !== undefined) {
    etag = `"${agreementNumber}:${version}:${WOODLAND_CONFIG_VERSION}"`;
    console.log(`[VU=${__VU}] GetCurrentAgreement ETag header absent — constructed: ${etag}`);
  }
  console.log(`[VU=${__VU}] GetCurrentAgreement agreementNumber=${agreementNumber} state=${body.agreement && body.agreement.state} etag=${etag}`);
  return { agreementNumber, etag };
}

/**
 * POST /agreements/{agreementNumber}/actions/accept
 * Accepts the WMP agreement offer. Expects a 303 redirect on success.
 * Returns true on success.
 */
function acceptAgreement(agreementNumber, applicant, etag) {
  const headers = Object.assign({}, gasHeaders(), {
    'x-agreement-source': 'defra',
    'x-agreement-sbi': String(applicant.sbi),
    'if-match': etag,
    'idempotency-key': uuidv4(),
  });
  const res = http.post(
    `${GAS_URL}/agreements/${agreementNumber}/actions/accept`,
    JSON.stringify({ values: { confirm: 'confirmed' } }),
    { headers, redirects: 0, tags: { name: 'AcceptAgreement' } },
  );
  logStep('AcceptAgreement', res);

  if (res.status === 303) {
    console.log(`[VU=${__VU}] Agreement ${agreementNumber} accepted successfully`);
    return true;
  }
  console.error(`[VU=${__VU}] AcceptAgreement returned status=${res.status} (expected 303)`);
  return false;
}

// ── GAS submission ────────────────────────────────────────────────────────────

function submitApplication(clientRef, applicant) {
  const submittedAt = new Date().toISOString();

  const payload = JSON.stringify({
    metadata: {
      clientRef,
      configVersion: WOODLAND_CONFIG_VERSION,
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
      centreGridReference: 'NG12345678',
      fcTeamCode: 'SOUTH_WEST',
      landParcels: [{ parcelId: 'AA0001-0001', areaHa: 10.0 }],
      applicant: {
        business: {
          name: applicant.name,
          reference: String(applicant.organisationId),
          email: `perf-test+${applicant.sbi}@example.test`,
          phone: '02011223344',
          address: {
            line1: '1 Test Lane',
            line2: 'Test Village',
            line3: null,
            line4: null,
            line5: null,
            street: '1 Test Lane',
            city: 'Exampleton',
            postalCode: 'ZZ99 5ZZ',
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
  console.log(`[VU=${__VU}] POST ${url} | clientRef=${clientRef}`);

  const res = http.post(url, payload, {
    headers: gasHeaders(),
    tags: { name: 'SubmitWmpApplication' },
  });

  logStep('SubmitWmpApplication', res);
  return assertStatus(res, 204, 'Submit WMP application');
}

// ── Agreement ready poll ──────────────────────────────────────────────────────

/**
 * After ACTION_APPROVE_APPLICATION, CW moves the case to STATUS_AGREEMENT_GENERATING
 * (non-interactive). GAS creates the agreement asynchronously and sends an event
 * back to CW, which then auto-transitions to STATUS_AGREEMENT_READY_FOR_APPLICANT
 * (STAGE_PREPARING_AGREEMENT) where the delivery task and confirm-sent action
 * become available. This poll waits for that transition by checking whether the
 * task link appears in the case page body.
 *
 * Returns true when ready, false on timeout.
 */
function waitForAgreementReady(caseId) {
  const AGREEMENT_READY_TIMEOUT_S = 60;
  const AGREEMENT_READY_INTERVAL_S = 5;
  const deadline = Date.now() + AGREEMENT_READY_TIMEOUT_S * 1000;
  const url = `${CW_FRONTEND_URL}/cases/${caseId}`;

  console.log(`[VU=${__VU}] Polling case ${caseId} for STATUS_AGREEMENT_READY_FOR_APPLICANT (timeout=${AGREEMENT_READY_TIMEOUT_S}s)`);

  while (Date.now() < deadline) {
    const res = http.get(url, {
      headers: cwBrowserHeaders(),
      redirects: 5,
      tags: { name: 'PollAgreementReady' },
    });

    if (res.url && res.url.indexOf('login.microsoftonline.com') !== -1) {
      console.error(`[VU=${__VU}] SESSION EXPIRED during agreement ready poll`);
      return false;
    }

    if (res.status === 200) {
      // TASK_AGREEMENT_DELIVERY_TO_APPLICANT link appears only in STAGE_PREPARING_AGREEMENT
      if (res.body.indexOf('TASK_AGREEMENT_DELIVERY_TO_APPLICANT') !== -1) {
        console.log(`[VU=${__VU}] Agreement ready — TASK_AGREEMENT_DELIVERY_TO_APPLICANT found in case page`);
        return true;
      }
      // Still generating — log and retry
      const generating = res.body.indexOf('AGREEMENT_GENERATING') !== -1 || res.body.indexOf('Generating draft agreement') !== -1;
      console.log(`[VU=${__VU}] Agreement not ready yet (generating=${generating}) — retrying in ${AGREEMENT_READY_INTERVAL_S}s`);
    } else {
      console.warn(`[VU=${__VU}] PollAgreementReady unexpected status=${res.status}`);
    }

    sleep(AGREEMENT_READY_INTERVAL_S);
  }

  console.warn(`[VU=${__VU}] Timed out waiting for agreement to be ready for case ${caseId}`);
  return false;
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

  console.log(`[VU=${__VU}] === Starting WMP full journey | clientRef=${clientRef} ===`);
  console.log(`[VU=${__VU}] GAS_URL=${GAS_URL} CW_FRONTEND_URL=${CW_FRONTEND_URL}`);
  console.log(`[VU=${__VU}] Session (first 60 chars): ${sessionValue ? sessionValue.substring(0, 60) : 'MISSING'}...`);

  // ── Phase 1: Submit application to GAS ──────────────────────────────────────
  if (!submitApplication(clientRef, applicant)) {
    console.error(`[VU=${__VU}] FAILED at Phase 1: GAS application submission`);
    return;
  }
  console.log(`[VU=${__VU}] Phase 1 complete: WMP application submitted clientRef=${clientRef}`);

  // Simulate application sitting in the queue before a caseworker picks it up
  console.log(`[VU=${__VU}] Think time: application submitted — waiting 10s before caseworker picks it up`);
  sleep(10);

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
  sleep(2);

  // ── Phase 4: Assign case to caseworker ──────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 4: Assigning case ${caseId} to user ${ASSIGNED_USER_ID}`);
  const assignUrl = `${CW_FRONTEND_URL}/cases/assign-user?caseId=${caseId}`;

  logStep('GetAssignUser', http.get(assignUrl, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetAssignUser' },
  }));
  sleep(2);

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
  sleep(2);

  logStep('GetCaseAfterAssign', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterAssign' },
  }));
  sleep(3);

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
  sleep(3);

  logStep('GetCaseAfterStartReview', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterStartReview' },
  }));
  sleep(3);

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
  sleep(3);

  logStep('GetCaseAfterApproval', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterApproval' },
  }));
  sleep(3);

  // ── Phase 7: Agreement delivery task ─────────────────────────────────────────
  // Wait for GAS to create the agreement and CW to auto-transition from
  // STATUS_AGREEMENT_GENERATING → STATUS_AGREEMENT_READY_FOR_APPLICANT
  console.log(`[VU=${__VU}] Phase 7: Waiting for agreement to be ready in CW (async GAS→CW event)`);
  if (!waitForAgreementReady(caseId)) {
    console.error(`[VU=${__VU}] FAILED at Phase 7: Agreement never became ready for case ${caseId}`);
    return;
  }

  console.log(`[VU=${__VU}] Phase 7: Completing agreement delivery task for case ${caseId}`);
  const taskGroup = 'TASK_GROUP_AGREEMENT_PREPARATION';
  const task = 'TASK_AGREEMENT_DELIVERY_TO_APPLICANT';
  const taskUrl = `${CW_FRONTEND_URL}/cases/${caseId}/tasks/${taskGroup}/${task}`;

  logStep('GetAgreementDeliveryTask', http.get(taskUrl, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetAgreementDeliveryTask' },
  }));
  sleep(3);

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
  sleep(3);

  logStep('GetCaseAfterAgreementTask', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterAgreementTask' },
  }));
  sleep(2);

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
  sleep(3);

  logStep('GetCaseAfterConfirmSent', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterConfirmSent' },
  }));
  sleep(2);

  // ── Phase 9: Browse case tabs ─────────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 9: Browsing case tabs for case ${caseId}`);

  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/case-details`, { headers: cwBrowserHeaders(), tags: { name: 'GetCaseDetails' } });
  sleep(2);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/agreements`, { headers: cwBrowserHeaders(), tags: { name: 'GetAgreements' } });
  sleep(2);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/timeline`, { headers: cwBrowserHeaders(), tags: { name: 'GetTimeline' } });
  sleep(2);
  http.get(`${CW_FRONTEND_URL}/cases/${caseId}/notes`, { headers: cwBrowserHeaders(), tags: { name: 'GetNotes' } });
  sleep(1);

  // ── Phase 10: Accept agreement ────────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 10: Accepting WMP agreement for clientRef=${clientRef}`);

  // Ensure agreement exists in GAS (idempotent — returns existing if CW already created it)
  const agreementNumber = createOrGetTestAgreement(clientRef, applicant);
  if (!agreementNumber) {
    console.error(`[VU=${__VU}] FAILED at Phase 10: Could not create/retrieve agreement`);
    return;
  }
  sleep(2);

  // Fetch ETag and accept — retry once if 412 (ETag can go stale due to async GAS processing)
  let accepted = false;
  for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
    const agreementCtx = getCurrentAgreement(clientRef, applicant);
    if (!agreementCtx) {
      console.error(`[VU=${__VU}] FAILED at Phase 10: Could not get agreement ETag (attempt ${attempt})`);
      return;
    }
    const result = acceptAgreement(agreementCtx.agreementNumber, applicant, agreementCtx.etag);
    if (result) {
      accepted = true;
    } else if (attempt === 1) {
      console.log(`[VU=${__VU}] AcceptAgreement attempt 1 failed — re-fetching ETag and retrying`);
      sleep(2);
    }
  }
  sleep(2);

  // ── Phase 11: CRM record task ─────────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 11: Completing CRM record task for case ${caseId}`);
  const crmTaskGroup = 'TASK_GROUP_CRM_RECORD';
  const crmTask = 'TASK_CRM_RECORD_CREATION';
  const crmTaskUrl = `${CW_FRONTEND_URL}/cases/${caseId}/tasks/${crmTaskGroup}/${crmTask}`;

  logStep('GetCrmRecordTask', http.get(crmTaskUrl, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCrmRecordTask' },
  }));
  sleep(2);

  const postCrmRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/task-groups/${crmTaskGroup}/tasks/${crmTask}/value`,
    'value=STATUS_CRM_RECORD_CREATED&STATUS_CRM_RECORD_CREATED-comment=' + encodeURIComponent('Create CRM record') + '&STATUS_CRM_RECORD_NOT_CREATED-comment=',
    {
      headers: cwFormHeaders(crmTaskUrl),
      redirects: 0,
      tags: { name: 'PostCrmRecordTask' },
    },
  );
  logStep('PostCrmRecordTask', postCrmRes);
  if (postCrmRes.status !== 302) {
    console.warn(`[VU=${__VU}] ${crmTask} POST returned ${postCrmRes.status} (expected 302)`);
  }
  sleep(2);

  logStep('GetCaseAfterCrmTask', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterCrmTask' },
  }));
  sleep(2);

  // ── Phase 12: Forward to FC ───────────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 12: ACTION_FORWARD_TO_FC for case ${caseId}`);
  const forwardToFcRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/stage/outcome`,
    'actionCode=ACTION_FORWARD_TO_FC&ACTION_FORWARD_TO_FC-comment=' + encodeURIComponent('Agreement accepted and forestry commission has been notified'),
    {
      headers: cwFormHeaders(`${CW_FRONTEND_URL}/cases/${caseId}`),
      redirects: 0,
      tags: { name: 'PostForwardToFc' },
    },
  );
  logStep('PostForwardToFc', forwardToFcRes);
  if (forwardToFcRes.status !== 302) {
    console.warn(`[VU=${__VU}] ACTION_FORWARD_TO_FC returned ${forwardToFcRes.status} (expected 302)`);
  }
  sleep(2);

  logStep('GetCaseAfterForwardToFc', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterForwardToFc' },
  }));
  sleep(2);

  // ── Phase 13: FC review task ──────────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 13: Completing FC review task for case ${caseId}`);
  const fcTaskGroup = 'TASK_GROUP_FC_REVIEW';
  const fcTask = 'TASK_FC_REVIEW_OUTCOME';
  const fcTaskUrl = `${CW_FRONTEND_URL}/cases/${caseId}/tasks/${fcTaskGroup}/${fcTask}`;

  logStep('GetFcReviewTask', http.get(fcTaskUrl, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetFcReviewTask' },
  }));
  sleep(2);

  const postFcReviewRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/task-groups/${fcTaskGroup}/tasks/${fcTask}/value`,
    'value=STATUS_FC_REVIEW_SUCCESSFUL&STATUS_FC_REVIEW_SUCCESSFUL-comment=' + encodeURIComponent('Record Forestry Commission outcome') + '&STATUS_FC_REVIEW_UNSUCCESSFUL-comment=',
    {
      headers: cwFormHeaders(fcTaskUrl),
      redirects: 0,
      tags: { name: 'PostFcReviewTask' },
    },
  );
  logStep('PostFcReviewTask', postFcReviewRes);
  if (postFcReviewRes.status !== 302) {
    console.warn(`[VU=${__VU}] ${fcTask} POST returned ${postFcReviewRes.status} (expected 302)`);
  }
  sleep(2);

  logStep('GetCaseAfterFcTask', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterFcTask' },
  }));
  sleep(2);

  // ── Phase 14: Approve FC review ───────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 14: ACTION_APPROVE_FC_REVIEW for case ${caseId}`);
  const approveFcRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/stage/outcome`,
    'actionCode=ACTION_APPROVE_FC_REVIEW&ACTION_APPROVE_FC_REVIEW-comment=' + encodeURIComponent('Forestry Commission review approved'),
    {
      headers: cwFormHeaders(`${CW_FRONTEND_URL}/cases/${caseId}`),
      redirects: 0,
      tags: { name: 'PostApproveFcReview' },
    },
  );
  logStep('PostApproveFcReview', approveFcRes);
  if (approveFcRes.status !== 302) {
    console.warn(`[VU=${__VU}] ACTION_APPROVE_FC_REVIEW returned ${approveFcRes.status} (expected 302)`);
  }
  sleep(2);

  // ── Phase 15: Browse final case tabs ──────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 15: Browsing final tabs for case ${caseId}`);
  logStep('GetCaseAgreements', http.get(`${CW_FRONTEND_URL}/cases/${caseId}/agreements`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAgreements' },
  }));
  sleep(1);

  logStep('GetCaseFinal', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseFinal' },
  }));
  sleep(1);

  // ── Phase 16: Claim prep tasks ───────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 16: Completing claim prep tasks for case ${caseId}`);
  const claimTaskGroup = 'TASK_GROUP_CLAIM_PREP';

  const eligibleAreaTaskUrl = `${CW_FRONTEND_URL}/cases/${caseId}/tasks/${claimTaskGroup}/TASK_RECORD_ELIGIBLE_AREA`;
  logStep('GetRecordEligibleAreaTask', http.get(eligibleAreaTaskUrl, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetRecordEligibleAreaTask' },
  }));
  sleep(2);

  const postEligibleAreaRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/task-groups/${claimTaskGroup}/tasks/TASK_RECORD_ELIGIBLE_AREA/value`,
    'value=STATUS_RECORDED&STATUS_RECORDED-comment=' + encodeURIComponent('Record total eligible approved area of woodland') + '&STATUS_NOT_RECORDED-comment=',
    {
      headers: cwFormHeaders(eligibleAreaTaskUrl),
      redirects: 0,
      tags: { name: 'PostRecordEligibleAreaTask' },
    },
  );
  logStep('PostRecordEligibleAreaTask', postEligibleAreaRes);
  if (postEligibleAreaRes.status !== 302) {
    console.warn(`[VU=${__VU}] TASK_RECORD_ELIGIBLE_AREA POST returned ${postEligibleAreaRes.status} (expected 302)`);
  }
  sleep(2);

  logStep('GetCaseAfterEligibleArea', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterEligibleArea' },
  }));
  sleep(2);

  const notifyTaskUrl = `${CW_FRONTEND_URL}/cases/${caseId}/tasks/${claimTaskGroup}/TASK_NOTIFY_READY_TO_CLAIM`;
  logStep('GetNotifyReadyToClaimTask', http.get(notifyTaskUrl, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetNotifyReadyToClaimTask' },
  }));
  sleep(2);

  const postNotifyRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/task-groups/${claimTaskGroup}/tasks/TASK_NOTIFY_READY_TO_CLAIM/value`,
    'value=STATUS_NOTIFICATION_SENT&STATUS_NOTIFICATION_SENT-comment=' + encodeURIComponent('Tell the customer they can make a claim') + '&STATUS_NOTIFICATION_NOT_SENT-comment=',
    {
      headers: cwFormHeaders(notifyTaskUrl),
      redirects: 0,
      tags: { name: 'PostNotifyReadyToClaimTask' },
    },
  );
  logStep('PostNotifyReadyToClaimTask', postNotifyRes);
  if (postNotifyRes.status !== 302) {
    console.warn(`[VU=${__VU}] TASK_NOTIFY_READY_TO_CLAIM POST returned ${postNotifyRes.status} (expected 302)`);
  }
  sleep(2);

  logStep('GetCaseAfterNotify', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseAfterNotify' },
  }));
  sleep(2);

  // ── Phase 17: Claim prep complete ────────────────────────────────────────────
  console.log(`[VU=${__VU}] Phase 17: ACTION_CLAIM_PREP_COMPLETE for case ${caseId}`);
  const claimPrepCompleteRes = http.post(
    `${CW_FRONTEND_URL}/cases/${caseId}/stage/outcome`,
    'actionCode=ACTION_CLAIM_PREP_COMPLETE',
    {
      headers: cwFormHeaders(`${CW_FRONTEND_URL}/cases/${caseId}`),
      redirects: 0,
      tags: { name: 'PostClaimPrepComplete' },
    },
  );
  logStep('PostClaimPrepComplete', claimPrepCompleteRes);
  if (claimPrepCompleteRes.status !== 302) {
    console.warn(`[VU=${__VU}] ACTION_CLAIM_PREP_COMPLETE returned ${claimPrepCompleteRes.status} (expected 302)`);
  }
  sleep(2);

  logStep('GetCaseFinal', http.get(`${CW_FRONTEND_URL}/cases/${caseId}`, {
    headers: cwBrowserHeaders(),
    tags: { name: 'GetCaseFinal' },
  }));
  sleep(1);

  console.log(`[VU=${__VU}] === COMPLETE: WMP full journey finished | clientRef=${clientRef} caseId=${caseId} ===`);
}
