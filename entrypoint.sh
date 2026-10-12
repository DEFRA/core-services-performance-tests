#!/bin/sh

echo "run_id: $RUN_ID in $ENVIRONMENT"

# CDP may provide one or both proxy settings. Use a working fallback and
# preserve existing NO_PROXY entries for local/internal services.
if [ -n "${CDP_HTTP_PROXY:-}" ] || [ -n "${CDP_HTTPS_PROXY:-}" ]; then
  export HTTP_PROXY="${CDP_HTTP_PROXY:-$CDP_HTTPS_PROXY}"
  export HTTPS_PROXY="${CDP_HTTPS_PROXY:-$CDP_HTTP_PROXY}"
  export NO_PROXY="${NO_PROXY:+$NO_PROXY,}.cdp-int.defra.cloud,localhost,127.0.0.1"
fi

REPORTS_DIR=/app/reports
mkdir -p "${REPORTS_DIR}/frps" "${REPORTS_DIR}/wmp"

COOKIE_GENERATION_MODE="${COOKIE_GENERATION_MODE:-browser}"
if [ "$COOKIE_GENERATION_MODE" = "browser" ] && {
  [ -z "${ENTRA_ID_WRITER_USER:-}" ] || [ -z "${ENTRA_ID_USER_PASSWORD:-}" ];
}; then
  echo "ERROR: Browser mode requires ENTRA_ID_WRITER_USER and ENTRA_ID_USER_PASSWORD"
  exit 1
fi

case "${CW_FRONTEND_BASE_URL:-}" in
  https://*|http://*) CW_FRONTEND_URL="$CW_FRONTEND_BASE_URL" ;;
  *) CW_FRONTEND_URL="https://${CW_FRONTEND_BASE_URL}" ;;
esac

printf '%s\n' '========================================' 'Generating CW session cookies' '========================================'
CW_FRONTEND_URL="$CW_FRONTEND_URL" \
  COOKIE_GENERATION_MODE="$COOKIE_GENERATION_MODE" \
  SESSION_COUNT="${SESSION_COUNT:-25}" \
  OUTPUT_FILE=/app/src/data/frps-session-cookies.csv \
  node /app/scripts/generate-session-cookies.js
if [ "$?" -ne 0 ]; then
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

run_scenario frps-full-journey-v2 frps &
FRPS_PID=$!
run_scenario wmp-full-journey wmp &
WMP_PID=$!
wait "$FRPS_PID"
FRPS_EXIT=$?
echo "frps-full-journey-v2 exit code: ${FRPS_EXIT}"
wait "$WMP_PID"
WMP_EXIT=$?
echo "wmp-full-journey exit code: ${WMP_EXIT}"

cat > "${REPORTS_DIR}/index.html" << 'HTML'
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
HTML

if [ -n "${RESULTS_OUTPUT_S3_PATH:-}" ]; then
  aws --endpoint-url="${S3_ENDPOINT}" s3 cp "${REPORTS_DIR}" "${RESULTS_OUTPUT_S3_PATH}" --recursive
  echo "Results uploaded to ${RESULTS_OUTPUT_S3_PATH}"
else
  echo "RESULTS_OUTPUT_S3_PATH is not set — skipping S3 upload"
fi

if [ "$FRPS_EXIT" -ne 0 ] || [ "$WMP_EXIT" -ne 0 ]; then
  echo "One or more scenarios failed (frps=${FRPS_EXIT} wmp=${WMP_EXIT})"
  exit 1
fi
