# Borrow the CDP proxy CA certificate from the CDP base image.
# Without it, Alpine's system Chromium rejects squid's SSL-inspection certificate
# and Microsoft auth CDN scripts fail to load, so the login form never renders.
FROM defradigital/cdp-perf-test-docker:latest AS cdp-base

FROM grafana/k6:0.54.0

USER root

COPY --from=cdp-base /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

RUN apk add --no-cache aws-cli nodejs npm chromium ca-certificates && update-ca-certificates

WORKDIR /app

COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev

COPY scripts/ ./scripts/
COPY src/ ./src/
COPY entrypoint.sh .

RUN chmod +x entrypoint.sh

RUN mkdir -p /app/reports/frps /app/reports/wmp && chown -R k6:k6 /app/reports

ENV SCENARIO=frps-full-journey-v2
ENV CW_FRONTEND_BASE_URL=fg-cw-frontend.perf-test.cdp-int.defra.cloud
ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

USER k6

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
