#!/bin/sh

echo "run_id: $RUN_ID in $ENVIRONMENT"

# Configure HTTP proxy if provided by CDP (needed for outbound internet access)
if [ -n "$CDP_HTTP_PROXY" ]; then
  export HTTP_PROXY="$CDP_HTTP_PROXY"
  export HTTPS_PROXY="$CDP_HTTPS_PROXY"
  export NO_PROXY=".cdp-int.defra.cloud"
fi

REPORTS_DIR=/app/reports

# Generate CW session cookies before running k6 scenarios
if [ -z "${ENTRA_ID_WRITER_USER}" ] || [ -z "${ENTRA_ID_USER_PASSWORD}" ]; then
  echo "ERROR: ENTRA_ID_WRITER_USER and ENTRA_ID_USER_PASSWORD are required"
  exit 1
fi

echo "========================================"
echo "Generating CW session cookies"
echo "========================================"

CW_FRONTEND_URL="https://${CW_FRONTEND_BASE_URL}" \
  OUTPUT_FILE=/app/src/data/frps-session-cookies.csv \
  SESSION_COUNT="${SESSION_COUNT:-25}" \
  npm run generate-cookies:frps

if [ $? -ne 0 ]; then
  echo "ERROR: Failed to generate session cookies"
  exit 1
fi
echo "Session cookies generated"

run_scenario() {
  SCENARIO=$1
  SCENARIO_FILE=/app/src/scenarios/${SCENARIO}.js
  SUB_DIR=${REPORTS_DIR}/${2}

  if [ ! -f "${SCENARIO_FILE}" ]; then
    echo "ERROR: Scenario file not found: ${SCENARIO_FILE}"
    return 1
  fi

  echo "Starting scenario: ${SCENARIO}"

  k6 run \
    --env GAS_BASE_URL="${GAS_BASE_URL}" \
    --env GAS_API_KEY="${GAS_API_KEY}" \
    --env GAS_BEARER_TOKEN="${GAS_BEARER_TOKEN}" \
    --env CW_FRONTEND_BASE_URL="${CW_FRONTEND_BASE_URL}" \
    --env CW_ASSIGNED_USER_ID="${CW_ASSIGNED_USER_ID}" \
    --env REPORTS_DIR="${SUB_DIR}" \
    --out json="${SUB_DIR}/output.json" \
    "${SCENARIO_FILE}"
}

# Run both scenarios in parallel
run_scenario frps-full-journey-v2 frps &
FRPS_PID=$!

run_scenario wmp-full-journey wmp &
WMP_PID=$!

wait $FRPS_PID
FRPS_EXIT=$?
echo "frps-full-journey-v2 exit code: ${FRPS_EXIT}"

wait $WMP_PID
WMP_EXIT=$?
echo "wmp-full-journey exit code: ${WMP_EXIT}"

# Create root index.html linking to both reports so CDP portal has an entry point
cat > "${REPORTS_DIR}/index.html" << 'EOF'
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Core Services Performance Test Results</title>
<style>body{font-family:sans-serif;margin:3rem;color:#222}h1{color:#333}ul{margin-top:1rem}li{margin:.5rem 0}a{color:#0056b3;font-size:1.1rem}</style>
</head>
<body>
<h1>Core Services Performance Test Results</h1>
<ul>
  <li><a href="frps/index.html">FRPS Full Journey</a></li>
  <li><a href="wmp/index.html">WMP Full Journey</a></li>
</ul>
</body>
</html>
EOF

if [ -n "${RESULTS_OUTPUT_S3_PATH}" ]; then
  aws --endpoint-url="${S3_ENDPOINT}" s3 cp "${REPORTS_DIR}" "${RESULTS_OUTPUT_S3_PATH}" --recursive
  echo "Results uploaded to ${RESULTS_OUTPUT_S3_PATH}"
else
  echo "RESULTS_OUTPUT_S3_PATH is not set — skipping S3 upload"
fi

if [ $FRPS_EXIT -ne 0 ] || [ $WMP_EXIT -ne 0 ]; then
  echo "One or more scenarios failed (frps=${FRPS_EXIT} wmp=${WMP_EXIT})"
  exit 1
fi
