FROM grafana/k6:0.54.0

USER root

RUN apk add --no-cache aws-cli

WORKDIR /app

COPY src/ ./src/
COPY entrypoint.sh .

RUN chmod +x entrypoint.sh

ENV GAS_BASE_URL=https://fg-gas-backend.dev.cdp-int.defra.cloud
ENV SCENARIO=gas-frps-claims-journey
ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com

USER k6

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
