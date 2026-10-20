FROM grafana/k6:0.54.0

USER root

RUN apk add --no-cache \
  aws-cli \
  nodejs \
  npm \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont

WORKDIR /app

# Install Node dependencies for cookie generation (skip Playwright browser download — use system Chromium)
COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev

COPY scripts/ ./scripts/
COPY src/ ./src/
COPY entrypoint.sh .

RUN chmod +x entrypoint.sh

RUN mkdir -p /app/reports/frps /app/reports/wmp /app/src/data && chown -R k6:k6 /app/reports /app/src/data

ENV SCENARIO=frps-full-journey-v2
ENV CW_FRONTEND_BASE_URL=fg-cw-frontend.perf-test.cdp-int.defra.cloud
ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

USER k6

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
