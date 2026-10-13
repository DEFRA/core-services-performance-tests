# Use the CDP base image as runtime — it carries the proxy CA cert, network
# configuration and package environment that makes Entra ID login work in CDP.
FROM grafana/k6:0.54.0 AS k6-source

FROM defradigital/cdp-perf-test-docker:latest

USER root

RUN apk add --no-cache \
    aws-cli \
    nodejs \
    npm \
    chromium \
    chromium-chromedriver \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# k6 is a standalone static binary — copy it directly from the official image.
COPY --from=k6-source /usr/bin/k6 /usr/local/bin/k6

WORKDIR /app

COPY auth/ ./auth/
RUN cd /app/auth && npm ci

COPY src/ ./src/
COPY entrypoint.sh .

RUN chmod +x entrypoint.sh \
    && mkdir -p /app/reports/frps /app/reports/wmp /app/src/data

ENV SCENARIO=frps-full-journey-v2
ENV CW_FRONTEND_BASE_URL=fg-cw-frontend.perf-test.cdp-int.defra.cloud
ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
