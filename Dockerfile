FROM grafana/k6:0.54.0

USER root

RUN apk add --no-cache aws-cli

WORKDIR /app

COPY src/ ./src/
COPY entrypoint.sh .

RUN chmod +x entrypoint.sh

RUN mkdir -p /app/reports && chown -R k6:k6 /app/reports

ENV SCENARIO=frps-full-journey-v2
ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com

USER k6

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
