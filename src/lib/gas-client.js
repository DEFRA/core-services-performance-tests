import http from 'k6/http';

const BASE_URL = __ENV.GAS_BASE_URL;
const API_KEY = __ENV.GAS_API_KEY;
const BEARER_TOKEN = __ENV.GAS_BEARER_TOKEN;

const headers = () => ({
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
  Authorization: `Bearer ${BEARER_TOKEN}`,
});

export const gasClient = ({ clientRef, code }) => ({
  getApplication() {
    return http.get(`${BASE_URL}/grants/${code}/applications/${clientRef}`, {
      headers: headers(),
      tags: { name: 'GetApplication' },
    });
  },

  getAvailableClaims() {
    return http.get(
      `${BASE_URL}/grants/${code}/entitlements/${clientRef}/available-claims`,
      {
        headers: headers(),
        tags: { name: 'GetAvailableClaims' },
      },
    );
  },

  submitClaim({ entitlementId, totalClaimAmountPence, idempotencyKey }) {
    return http.post(
      `${BASE_URL}/grants/${code}/applications/${clientRef}/claims`,
      JSON.stringify({
        claim: { entitlementId, totalClaimAmountPence },
        metadata: {},
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          Authorization: `Bearer ${BEARER_TOKEN}`,
          'idempotency-key': idempotencyKey,
        },
        tags: { name: 'SubmitClaim' },
      },
    );
  },
});
