# Production operations

The selected target is [ADR-0020](decisions/0020-single-host-production-deployment.md): Oracle Always Free in Frankfurt with a $0 hosting budget. These are prepared deployment instructions, not evidence that Oracle resources, DNS, external mail or OAuth are deployed. Track delivery in the [roadmap](roadmap.md#phase-5--analysis-polish-and-release-hardening).

## Host and network

Select Frankfurt as the OCI tenancy home region before creating resources. Confirm available Always Free Ampere A1 capacity, use one Ubuntu 24.04 ARM64 VM within the account's 2 OCPU/12 GB allocation, and begin with a 50 GB boot volume. Keep total boot/block storage and backups inside the console's free allowance. If capacity is unavailable or the console quotes a charge, stop provisioning and revisit the choice; do not silently buy another shape. Idle instances may be reclaimed.

Install Docker Engine, Compose with support for `!override` (2.24.4 or newer), Git and OpenSSL. Restrict SSH to operator addresses. Allow public TCP 80/443 through the OCI network security group and host firewall. Permit outbound DNS, HTTPS for providers/OAuth and the chosen TLS SMTP port. Do not publish 3001, 5432 or Docker's control socket. Avoid an extra CDN/proxy until its trust boundary is reviewed.

Point `arena.<your-domain>` and `api.<your-domain>` at the VM, on the same registrable domain. `deploy/compose.yml` uses only Caddy's published ports; its API has no host port and the database network is internal. Caddy issues public HTTPS certificates and persists them in its own volume. API startup validates exact HTTPS origins and same-site relationships, including private suffixes. No forwarded IP is trusted by the API yet; the existing per-IP protections see the edge address. P5-11 owns consistent client-IP trust and production abuse limits before release.

## Secrets and database TLS

Use an operator-only directory outside Git, for example `/etc/neurochess`, protected with mode 0700. Store recoverable auth/encryption/SMTP/OAuth secrets in OCI Vault or equivalent deployment secret storage, separate from PostgreSQL. Materialize them on the host only for the container runtime. Never print resolved Compose configuration, environment values, mail bodies or database dumps to CI logs.

For a new installation only, run the following as the operator in a protected shell. Existing installations must preserve database passwords and auth/encryption keys.

```sh
umask 077
mkdir -p /etc/neurochess/secrets
openssl rand -hex 32 > /etc/neurochess/secrets/postgres-admin-password
openssl rand -hex 32 > /etc/neurochess/secrets/postgres-app-password
openssl req -x509 -newkey rsa:3072 -nodes -days 365 \
  -subj /CN=postgres -addext subjectAltName=DNS:postgres \
  -addext basicConstraints=critical,CA:TRUE \
  -keyout /etc/neurochess/secrets/postgres-key.pem \
  -out /etc/neurochess/secrets/postgres-cert.pem
chmod 644 /etc/neurochess/secrets/postgres-cert.pem
```

The public certificate must be readable by the unprivileged API container. Keep its private key and passwords mode 0600. Compose secrets use read-only file mounts, not an encrypted secret manager. The database entrypoint copies its server key with the PostgreSQL user's ownership; clients trust only the mounted public certificate and verify the `postgres` hostname. Remote non-TLS connections are rejected. PostgreSQL's admin role is available only through local container administration; the application role owns its schema without superuser privileges.

Prepare `/etc/neurochess/api.env` with mode 0600. Supply actual values through the secret store/editor; placeholders below are not runnable credentials:

```dotenv
DATABASE_URL=postgresql://neurochess:APP_PASSWORD@postgres:5432/neurochess?sslmode=verify-full&sslrootcert=/run/secrets/postgres-cert
BETTER_AUTH_SECRET=RANDOM_STABLE_AUTH_SECRET_AT_LEAST_32_CHARACTERS
CREDENTIAL_ENCRYPTION_KEY_ID=provider-keys-v1
CREDENTIAL_ENCRYPTION_KEY=BASE64_OF_32_RANDOM_BYTES
AUTH_EMAIL_TRANSPORT=smtp
AUTH_EMAIL_FROM=accounts@YOUR_DOMAIN
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USER=YOUR_SMTP_LOGIN
SMTP_PASSWORD=YOUR_SMTP_KEY
GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID=YOUR_GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=YOUR_GITHUB_CLIENT_SECRET
LOG_LEVEL=info
```

Replace `APP_PASSWORD` with the exact generated application password. Generate each auth/encryption secret independently; never derive it from a database password. Omit both OAuth variables to disable a provider in an isolated rehearsal, but both providers and saved-key storage are required for MVP release acceptance. Follow the existing [OAuth console setup](development.md#google-and-github-oauth): callbacks are `https://api.<your-domain>/api/auth/callback/google` and `/github`. Verify the SMTP sender domain and use the SMTP credential, not a provider API key. Never disable TLS verification.

Before the PostgreSQL certificate expires, schedule a maintenance stop, replace the certificate/key together, remount the public certificate for API/migration clients, and restart PostgreSQL followed by the API. Preserve passwords and database data. Back up recoverable application secrets independently; certificate generation is not an encryption-key rotation procedure.

## Artifacts and rollout

Use a clean, reviewed release checkout. The Docker build ignores local environments, tests, credentials and prior build output; npm installs from the lockfile. It validates the public API URL before generating web assets, rejecting HTTP and credential-bearing URLs. `deploy/Dockerfile` pins Node 24.19.0, npm 11.21.0 and base manifest digests. Its API runs as an unprivileged user with production dependencies and compiled code. Caddy serves the web artifact directly; `npm start` and Vite preview remain local tools.

Copy `deploy/.env.example` to `/etc/neurochess/deploy.env` and set real origins, external file paths and unique immutable release image tags. In the release checkout, build both images with the same API origin that Compose uses:

```sh
RELEASE=$(git rev-parse HEAD)
docker build -f deploy/Dockerfile --target api \
  --build-arg VITE_API_BASE_URL=https://api.YOUR_DOMAIN -t neurochess-api:$RELEASE .
docker build -f deploy/Dockerfile --target web \
  --build-arg VITE_API_BASE_URL=https://api.YOUR_DOMAIN -t neurochess-web:$RELEASE .
```

Build natively on ARM64 or use `docker buildx build --platform linux/arm64 --load` when preparing Oracle images elsewhere. Never transfer an AMD64-only image to the A1 host. Preserve previous API/web images for rollback and record their image IDs. Image publication is not part of the build commands or CI. The current repository-license decision and compatibility review still gate public Stockfish distribution.

Use the same Compose project name, configuration revision and secret directory for every release. Run these commands from the release checkout, after setting the desired image tags in the external deployment environment:

```sh
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml config --quiet
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml stop api
docker inspect neurochess-api --format '{{.State.Running}} {{.State.ExitCode}}'
# On the first installation there is no API container to inspect.
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml up -d --wait postgres
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml run --rm migrate
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml up -d --wait api
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml up -d web
```

Confirm the old API is stopped before migration; a failed drain needs investigation. The API rejects new requests when closing, closes room sockets, waits for in-flight HTTP/SMTP and database work, and exits. It has a 210-second shutdown deadline; Compose permits 220 seconds. This covers the existing 180-second AI turn scope plus cleanup. Unexpected termination retains the existing explicit AI recovery and room resynchronization semantics. Do not use `up` as a substitute for the stop/inspect/migrate sequence or run two Compose projects against the same database.

Migrations run through the compiled CLI in the exact API image, outside normal startup. They are repeatable, forward-only and must finish before the API opens. Review SQL and populated-schema evidence for every migration. P5-10 adds no migration and retains schema `0021`; earlier compatibility restrictions in the [migration guide](development.md#migrations) still apply. Migration errors are fixed messages rather than raw connection exceptions.

If migration or startup fails, keep the API stopped. Roll back the API/web image pair only if that previous release is compatible with the current schema and canonical browser routes; use the same stop/inspect sequence and preserved secrets. Do not down-migrate SQL, overwrite a populated volume or restore a dump over a running service. An incompatible schema requires a forward fix or the separately tested isolated restoration procedure. `docker compose down --volumes` is destructive and is used only by the disposable rehearsal, never in this runbook's production procedure.

## Probes and acceptance

`/health` establishes process liveness; `/ready` checks PostgreSQL and returns 503 when unavailable. Pool acquisition/connect and readiness query waits are each bounded at five seconds. Caddy preserves private JSON responses and WebSocket upgrades on the API origin. It serves deep-link SPA documents on the web origin, returns 404 for missing assets even with an HTML Accept header, uses immutable caching for hashed application assets, and serves engine JS/WASM/source/notices without fallback. HTML revalidates on navigation.

The API accepts at most 1 MiB globally, with existing narrower route limits. Inbound requests have a 30-second receipt timeout; idle connections have a 210-second timeout and HTTP keep-alive is five seconds. Caddy has a ten-second header timeout and a 210-second upstream response-header timeout, retaining the longer AI operation budget. Complete rate policies and response headers belong to P5-11/P5-12. Traffic/access-error logs at Caddy are disabled to avoid retaining callback/invitation URLs; API logging keeps its existing redaction. Docker log rotation is bounded. Operational alerting remains P5-13.

Run local proof with Docker, OpenSSL and all three Playwright browsers installed:

```text
npm run build:deployment:test
npm run test:deployment
```

The rehearsal creates its own project, generated TLS/secrets, PostgreSQL volume and TLS mailbox, and removes them afterward. It exercises real compiled services, static routing/MIME/cache rules, SMTP registration, secure sessions, private rooms and sockets through Caddy, worker/WASM loading in Chromium/Firefox/WebKit, populated migrations, graceful restart and database failure/recovery. Set `DEPLOY_ROLLBACK_API_IMAGE` to a locally retained prior-release image to additionally verify that the prior binary can read the populated schema and sessions, then return to the new binary. Only test a release whose compatibility has been reviewed; passing an identical new image does not establish backward compatibility. Its local browser certificate exception and mailbox are test-only mounts; they are absent from production images/configuration. No outbound mail or inference is required. CI repeats the current-image rehearsal on AMD64 and ARM64 without publishing images or private artifacts.

Before public release, still verify actual Oracle capacity/networking, domain ownership and public TLS, both OAuth consents, SMTP inbox delivery, provider calls, and same-site cookies/sockets on the live host. Configure OCI monitoring/alerts in P5-13 and agree/test database backup retention, separate secret recovery and restoration in P5-14. OCI volume backups/object storage are available within quotas, but no successful backup or restore is claimed here. Complete the physical-browser/accessibility and licensing gates in P5-15.
