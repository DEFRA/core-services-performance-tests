FROM grafana/k6:0.54.0

USER root

# Install aws-cli, Node.js, and system Chromium (for Playwright cookie generation)
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

# Use system Chromium — skip Playwright's own browser download
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Print the actual Chromium path at build time for verification
RUN which chromium-browser 2>/dev/null || which chromium 2>/dev/null || echo "WARNING: chromium not found"

# Alpine's chromium package installs to /usr/bin/chromium-browser
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY scripts/ ./scripts/
COPY src/ ./src/
COPY entrypoint.sh .

RUN chmod +x entrypoint.sh

RUN mkdir -p /app/reports/frps /app/reports/wmp /app/src/data && \
    chown -R k6:k6 /app/reports /app/src/data

ENV SCENARIO=frps-full-journey-v2
ENV CW_FRONTEND_BASE_URL=fg-cw-frontend.perf-test.cdp-int.defra.cloud
ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com

USER k6

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
