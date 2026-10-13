# core-services-performance-tests

A JMeter based test runner for the CDP Platform.

- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Build

Test suites are built automatically by the [.github/workflows/publish.yml](.github/workflows/publish.yml) action whenever a change are committed to the `main` branch.
A successful build results in a Docker container that is capable of running your tests on the CDP Platform and publishing the results to the CDP Portal.

## Run

The performance test suites are designed to be run from the CDP Portal.
The CDP Platform runs test suites in much the same way it runs any other service, it takes a docker image and runs it as an ECS task, automatically provisioning infrastructure as required.

## Local Testing with Docker Compose

You can run the entire performance test stack locally using Docker Compose, including LocalStack, Redis, and the target service. This is useful for development, integration testing, or verifying your test scripts **before committing to `main`**, which will trigger GitHub Actions to build and publish the Docker image.

### Build the Docker image

```bash
docker compose build --no-cache development
```

This ensures any changes to `entrypoint.sh` or other scripts are picked up properly.

---

### Start the full test stack

```bash
docker compose up --build
```

This brings up:

* `development`: the container that runs your performance tests
* `localstack`: simulates AWS S3, SNS, SQS, etc.
* `redis`: backing service for cache
* `service`: the application under test

Once all services are healthy, your performance tests will automatically start.

---

### Replace `service-name` in Compose File

In the `docker-compose.yml`, make sure to replace:

```yaml
image: defradigital/service-name:${SERVICE_VERSION:-latest}
```

with the actual name of your service’s image.

This is the service under test, which must expose a `/health` endpoint and listen on port `3000`.

---

### Notes

* S3 bucket is expected to be `s3://test-results`, automatically created inside LocalStack.
* Logs and reports are written to `./reports` on your host.
* `entrypoint.sh` should contain the logic to wait for dependencies and kick off the test run.
* The `depends_on` healthchecks ensure services like `localstack` and `service` are ready before tests start.
* If you make changes to test scripts or entrypoints, rerun with:

```bash
docker compose up --build
```

## Local Testing with LocalStack

### Build a new Docker image
```
docker build . -t my-performance-tests
```
### Create a Localstack bucket
```
aws --endpoint-url=localhost:4566 s3 mb s3://my-bucket
```

### Run performance tests

```
docker run \
-e S3_ENDPOINT='http://host.docker.internal:4566' \
-e RESULTS_OUTPUT_S3_PATH='s3://my-bucket' \
-e AWS_ACCESS_KEY_ID='test' \
-e AWS_SECRET_ACCESS_KEY='test' \
-e AWS_SECRET_KEY='test' \
-e AWS_REGION='eu-west-2' \
my-performance-tests
```

docker run -e S3_ENDPOINT='http://host.docker.internal:4566' -e RESULTS_OUTPUT_S3_PATH='s3://cdp-infra-dev-test-results/cdp-portal-perf-tests/95a01432-8f47-40d2-8233-76514da2236a' -e AWS_ACCESS_KEY_ID='test' -e AWS_SECRET_ACCESS_KEY='test' -e AWS_SECRET_KEY='test' -e AWS_REGION='eu-west-2' -e ENVIRONMENT='perf-test' my-performance-tests


---

## WMP Full Journey — Prerequisites & Gotchas

### What the script does

`src/scenarios/wmp-full-journey.js` runs a full end-to-end WMP (Woodland Management Plan) journey:

1. **Submit WMP application** to GAS (`POST /grants/woodland/applications`)
2. **Poll** for the CW case to be created (async SNS/SQS delay)
3. **CW caseworker login** (via session cookies from CSV)
4. **Assign case** to the perf-test caseworker
5. **ACTION_START_REVIEW** → STATUS_APPLICATION_IN_REVIEW
6. **Manual review tasks** (all ACCEPTED): `CHECK_DOCUMENTS`, `CHECK_MAP`, `CHECK_SITE_VISIT`, `SEND_FC_TO_ASSESS`
7. **Wait** for CW case to transition STATUS_AGREEMENT_GENERATING → STATUS_AGREEMENT_READY_FOR_APPLICANT (GAS creates the agreement asynchronously)
8. **Complete agreement delivery tasks**: `CONFIRM_WMP_REVIEW`, `PRODUCE_AGREEMENT`, `APPROVE_AGREEMENT`
9. **ACTION_CONFIRM_AGREEMENT_SENT** → STATUS_AGREEMENT_WITH_CUSTOMER
10. **Accept agreement** via GAS: `GET /agreements/current` → `POST /agreements/{number}/actions/accept`

### Step 1 — Check the deployed grants-config-woodland version

Before running locally or deploying, verify the version of `grants-config-woodland` deployed to perf-test:

- CDP Portal → Services → grants-config-woodland → check the deployed tag

Then update `WOODLAND_CONFIG_VERSION` at the top of `wmp-full-journey.js` if it differs:

```js
const WOODLAND_CONFIG_VERSION = __ENV.WOODLAND_CONFIG_VERSION || '1.43.1'; // ← update this
```

**Why this matters:** The WMP application submit payload uses this version as `configVersion`. GAS resolves the grant config by major version — if the version here is in a different major (e.g. `0.x.x` vs `1.x.x`) from what is registered in perf-test, agreement generation will fail with `"Agreement definition 'woodland' version 'X.Y.Z' is unavailable"`.

### Step 2 — Generate CW session cookies

```bash
cd /Users/nitinmali/workspace/farming/core-services-performance-tests
CW_FRONTEND_URL=https://fg-cw-frontend.perf-test.cdp-int.defra.cloud \
  ENTRA_ID_WRITER_USER=SA-FGCW.WRITER@defra.onmicrosoft.com \
  ENTRA_ID_USER_PASSWORD='FgGrants-2026' \
  SESSION_COUNT=5 \
  OUTPUT_FILE=src/data/frps-session-cookies.csv \
  npm run generate-cookies
```

The WMP script shares the same cookie file as FRPS. Cookies expire after 4 hours — regenerate immediately before running.

### Step 3 — Run locally (1 iteration smoke test)

```bash
mkdir -p reports/wmp && \
k6 run --vus 1 --iterations 1 \
  -e GAS_BASE_URL=ephemeral-protected.api.perf-test.cdp-int.defra.cloud/fg-gas-backend \
  -e GAS_API_KEY=<your-developer-api-key> \
  -e GAS_BEARER_TOKEN=99731eaa-43e6-44fe-a18c-25385c1a3a93 \
  -e CW_FRONTEND_BASE_URL=fg-cw-frontend.perf-test.cdp-int.defra.cloud \
  -e CW_ASSIGNED_USER_ID=69c2749c461dcb042523bd16 \
  -e REPORTS_DIR=reports/wmp \
  src/scenarios/wmp-full-journey.js
```

### Key gotchas

| Issue | Root cause | Fix |
|-------|-----------|-----|
| `"Agreement definition 'woodland' version 'X.Y.Z' is unavailable"` | `configVersion` in submit payload resolves to wrong major in GAS config catalog | Set `WOODLAND_CONFIG_VERSION` to match deployed grants-config-woodland tag |
| Agreement generation never completes (STATUS_AGREEMENT_GENERATING loops forever) | `configVersion` in submit payload is wrong major — GAS uses old 0.x.x catalog entry, CW sends back `currentConfigVersion: '0.0.0'`, GAS can't find agreement definition | Same fix as above |
| `gzip: invalid header` on GAS requests (status=0 in k6) | k6 can't decompress gzip response from GAS | `'Accept-Encoding': 'identity'` in all GAS request headers |
| `412 Agreement version is stale` on accept | GAS async processing (outbox delivery, CW events) can update the agreement version between `GET /agreements/current` and `POST .../accept` | Script re-fetches ETag and retries once automatically |
| `ACTION_CONFIRM_AGREEMENT_SENT` returns 400 | Case is still in STATUS_AGREEMENT_GENERATING (non-interactive) when script tries to proceed | Script polls for `TASK_AGREEMENT_DELIVERY_TO_APPLICANT` in CW case page body before continuing |
| `open reports/wmp/index.html: no such file or directory` | Reports directory not created before k6 run | Prefix run command with `mkdir -p reports/wmp &&` |

### Agreement lifecycle in perf-test

The WMP agreement is created end-to-end through the normal GAS flow:

```
ACTION_APPROVE_APPLICATION (CW)
  → STATUS_AGREEMENT_GENERATING (CW, non-interactive)
  → CaseStatusUpdatedEvent (CW → GAS, includes currentConfigVersion)
  → GAS creates agreement (loadAgreementDefinition at currentConfigVersion)
  → GAS outbox delivers agreement lifecycle event to CW
  → STATUS_AGREEMENT_READY_FOR_APPLICANT (CW)
```

`POST /api/test/agreements` is called as a safety net only — it's idempotent and returns the existing agreement if one already exists for the same clientRef + code.

---

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government licence v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
