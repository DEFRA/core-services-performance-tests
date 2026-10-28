import { requiredEnvironmentValue } from '../lib/runtime-inputs.js';
/**
 * WMP Applicant Journey
 *
 * Submits WMP (Woodland Management Plan) applications directly to the GAS API.
 * Bypasses grants-ui entirely — GAS is mocked in perf-test env so applications
 * are accepted without reaching the real GAS backend.
 *
 * Pre-conditions:
 *   - GAS_BASE_URL, GAS_API_KEY, GAS_BEARER_TOKEN must be set
 *   - frps-applicants.json must contain test applicants (reused for WMP)
 */
import http from 'k6/http';
import { SharedArray } from 'k6/data';
import { assertStatus } from '../lib/checks.js';
import { handleSummary } from '../lib/report.js';

export { handleSummary };

const GAS_URL = `https://${__ENV.GAS_BASE_URL}`;
const GAS_API_KEY = __ENV.GAS_API_KEY;
const GAS_BEARER_TOKEN = requiredEnvironmentValue(__ENV, 'GAS_BEARER_TOKEN');

const applicants = new SharedArray('frps-applicants', () =>
  JSON.parse(open('../data/frps-applicants.json')),
);

export const options = {
  scenarios: {
    wmp_applicant_journey: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5m',  target: 10 },
        { duration: '50m', target: 10 },
        { duration: '5m',  target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    http_req_failed: ['rate<0.05'],
    errors: ['rate<0.05'],
  },
};

const gasHeaders = () => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Authorization: `Bearer ${GAS_BEARER_TOKEN}`,
  'x-api-key': GAS_API_KEY,
});

// ── Logging helper ────────────────────────────────────────────────────────────

function logStep(label, res) {
  const location = res.headers['Location'] ? ` → ${res.headers['Location']}` : '';
  console.log(`[VU=${__VU}] ${label} | status=${res.status}${location}`);
  if (res.body && res.body.length > 0) {
    // Truncate large bodies; show first 500 chars
    const snippet = res.body.length > 500 ? res.body.substring(0, 500) + '...(truncated)' : res.body;
    console.log(`[VU=${__VU}] ${label} | body=${snippet}`);
  }
}

/**
 * Submits a WMP application to GAS.
 * Returns true on success, false on failure.
 */
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

// ── Main scenario ─────────────────────────────────────────────────────────────

export default function () {
  const applicant = applicants[__VU % applicants.length];
  const runId = Math.floor(Date.now() / 1000);
  const clientRef = `wmp-perf-${runId}-${__VU}-${__ITER}`;

  console.log(`[VU=${__VU}] === Starting WMP journey | clientRef=${clientRef} ===`);
  console.log(`[VU=${__VU}] GAS_URL=${GAS_URL}`);

  if (!submitApplication(clientRef, applicant)) {
    console.error(`[VU=${__VU}] FAILED: WMP application submission failed for clientRef=${clientRef}`);
    return;
  }
  console.log(`[VU=${__VU}] === SUCCESS: WMP application submitted | clientRef=${clientRef} ===`);
}
