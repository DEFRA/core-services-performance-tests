#!/bin/sh

echo "run_id: $RUN_ID in $ENVIRONMENT"

# Configure HTTP proxy if provided by CDP (needed for any outbound internet access)
if [ -n "$CDP_HTTP_PROXY" ]; then
  export HTTP_PROXY="$CDP_HTTP_PROXY"
  export HTTPS_PROXY="$CDP_HTTPS_PROXY"
  export NO_PROXY=".cdp-int.defra.cloud"
fi

SCENARIO=${SCENARIO:-frps-full-journey-v2}
SCENARIO_FILE=/app/src/scenarios/${SCENARIO}.js
REPORTS_DIR=/app/reports

mkdir -p "${REPORTS_DIR}"

if [ ! -f "${SCENARIO_FILE}" ]; then
  echo "ERROR: Scenario file not found: ${SCENARIO_FILE}"
  exit 1
fi

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

K6_EXIT_CODE=$?

if [ -n "${RESULTS_OUTPUT_S3_PATH}" ]; then
  aws --endpoint-url="${S3_ENDPOINT}" s3 cp "${REPORTS_DIR}" "${RESULTS_OUTPUT_S3_PATH}" --recursive
  echo "Results uploaded to ${RESULTS_OUTPUT_S3_PATH}"
else
  echo "RESULTS_OUTPUT_S3_PATH is not set — skipping S3 upload"
fi

if [ $K6_EXIT_CODE -ne 0 ]; then
  echo "k6 exited with code ${K6_EXIT_CODE} (threshold failures or script error)"
  exit $K6_EXIT_CODE
fi
