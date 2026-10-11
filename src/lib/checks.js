import { check } from 'k6';
import { Rate } from 'k6/metrics';

export const errorRate = new Rate('errors');

/**
 * Asserts an expected HTTP status and records failures in the error rate metric.
 *
 * Usage:
 *   assertStatus(res, 200, 'Submit claim');
 */
export const assertStatus = (res, expectedStatus, label) => {
  const passed = check(res, {
    [`${label}: status ${expectedStatus}`]: (r) => r.status === expectedStatus,
  });

  errorRate.add(!passed);

  return passed;
};

/**
 * Parses and returns the JSON body of a response.
 * Returns null and logs a warning if parsing fails.
 */
export const parseJson = (res, label) => {
  try {
    return res.json();
  } catch (_) {
    console.warn(`${label}: failed to parse JSON response`);
    return null;
  }
};
