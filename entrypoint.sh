#!/bin/sh
set -e

echo "run_id: $RUN_ID in $ENVIRONMENT"

SCENARIO=${SCENARIO:-gas-frps-claims-journey}
SCENARIO_FILE=/app/src/scenarios/${SCENARIO}.js
REPORTS_DIR=/app/reports

mkdir -p "${REPORTS_DIR}"

echo "Running scenario: ${SCENARIO}"

k6 run \
  --env GAS_BASE_URL="${GAS_BASE_URL}" \
  --env GAS_API_KEY="${GAS_API_KEY}" \
  --env GAS_BEARER_TOKEN="${GAS_BEARER_TOKEN}" \
  --env CW_FRONTEND_BASE_URL="${CW_FRONTEND_BASE_URL}" \
  --env CW_BACKEND_BASE_URL="${CW_BACKEND_BASE_URL}" \
  --env CW_API_KEY="${CW_API_KEY}" \
  --env CW_ASSIGNED_USER_ID="${CW_ASSIGNED_USER_ID}" \
  --out json="${REPORTS_DIR}/output.json" \
  "${SCENARIO_FILE}"

if [ -n "${RESULTS_OUTPUT_S3_PATH}" ]; then
  aws --endpoint-url="${S3_ENDPOINT}" s3 cp "${REPORTS_DIR}" "${RESULTS_OUTPUT_S3_PATH}" --recursive
  echo "Results uploaded to ${RESULTS_OUTPUT_S3_PATH}"
else
  echo "RESULTS_OUTPUT_S3_PATH is not set — skipping S3 upload"
fi
