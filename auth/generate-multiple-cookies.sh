#!/bin/sh
# Generate multiple CW session cookies and write them to a CSV file for k6.
# Usage: sh generate-multiple-cookies.sh [count]
# Env:   OUTPUT_FILE  path to write CSV (default: /app/src/data/frps-session-cookies.csv)
#        CW_FRONTEND_URL, ENTRA_ID_WRITER_USER, ENTRA_ID_USER_PASSWORD  (required)

cd "$(dirname "$0")"

COUNT=${1:-25}
OUTPUT_FILE="${OUTPUT_FILE:-/app/src/data/frps-session-cookies.csv}"

echo "========================================"
echo "Generating $COUNT CW session cookies"
echo "Output: $OUTPUT_FILE"
echo "========================================"

mkdir -p "$(dirname "$OUTPUT_FILE")"
echo "cookieHeader" > "$OUTPUT_FILE"

i=1
while [ "$i" -le "$COUNT" ]; do
  echo ""
  echo "=== Cookie $i/$COUNT ==="
  OUTPUT_FILE="$OUTPUT_FILE" npm run generate-cookie-http

  if [ $? -ne 0 ]; then
    echo "ERROR: Failed to generate cookie $i"
    exit 1
  fi

  if [ "$i" -lt "$COUNT" ]; then
    sleep 2
  fi

  i=$((i + 1))
done

echo ""
echo "========================================"
COOKIE_COUNT=$(tail -n +2 "$OUTPUT_FILE" | wc -l | tr -d ' ')
echo "Done — $COOKIE_COUNT cookies written to $OUTPUT_FILE"
echo "========================================"
