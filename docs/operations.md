# Production operations

The selected target is [ADR-0020](decisions/0020-single-host-production-deployment.md): Oracle Always Free in Frankfurt with a $0 hosting budget. These are prepared deployment instructions, not evidence that Oracle resources, DNS, external mail or OAuth are deployed. Track delivery in the [roadmap](roadmap.md#phase-5--analysis-polish-and-release-hardening).

## Host and network

Select Frankfurt as the OCI tenancy home region before creating resources. Confirm available Always Free Ampere A1 capacity, use one Ubuntu 24.04 ARM64 VM within the account's 2 OCPU/12 GB allocation, and begin with a 50 GB boot volume. Keep total boot/block storage and backups inside the console's free allowance. If capacity is unavailable or the console quotes a charge, stop provisioning and revisit the choice; do not silently buy another shape. Idle instances may be reclaimed.

Install Docker Engine, Compose with support for `!override` (2.24.4 or newer), Git and OpenSSL. Restrict SSH to operator addresses. Allow public TCP 80/443 through the OCI network security group and host firewall. Permit outbound DNS, HTTPS for providers/OAuth and the chosen TLS SMTP port. Do not publish 3001, 5432 or Docker's control socket. Avoid an extra CDN/proxy until its trust boundary is reviewed.

Point `arena.<your-domain>` and `api.<your-domain>` at the VM, on the same registrable domain. `deploy/compose.yml` uses only Caddy's published ports; its API has no host port and the database network is internal. Caddy issues public HTTPS certificates and persists them in its own volume. API startup validates exact HTTPS origins and same-site relationships, including private suffixes.

Caddy has a fixed address (`PROXY_IP`, default `172.30.0.2`) on `EDGE_SUBNET` (default `172.30.0.0/24`). Set `EDGE_DYNAMIC_RANGE` (default `172.30.0.128/25`) inside that subnet but excluding the fixed proxy IP, so API/migration or other containers started first cannot claim it. Choose all three values together on a non-overlapping subnet. Compose supplies that exact address as the API's required production `TRUSTED_PROXY_IP`. The API trusts only that direct socket peer, never a private subnet or a hop count alone. Caddy overwrites `X-Forwarded-For` with its connection's remote IP and removes `Forwarded`/`X-Real-IP`. A trusted peer must supply exactly one valid IP; missing, chained and scoped addresses are rejected. Other peers' forwarding assertions are ignored. Auth, HTTP limits and socket admission use the same normalized address. Keep the API port private and do not insert a CDN or another forwarding hop without revisiting this boundary.

## Request and socket limits

The API enforces these fixed 60-second windows in `apps/api/src/limits/policy.ts`. IP budgets are shared by clients behind NAT; verified identity budgets use the account UUID across sessions or the guest UUID, never supplied identity headers or cookie text. IPv4-mapped addresses normalize to IPv4 and IPv6 privacy addresses share a `/64` IP budget. Admission counts rejected/invalid attempts too, before body parsing and authentication. Identity limits run after cookie verification, before application reads, mutations and provider dispatch.

| Traffic                                                       | Per IP/minute | Per verified identity/minute | In-flight requests per API |
| ------------------------------------------------------------- | ------------: | ---------------------------: | -------------------------: |
| Guest bootstrap                                               |           120 |                            — |                         32 |
| Auth bridge (additional to existing endpoint limits)          |          3600 |                            — |                        128 |
| Provider discovery                                            |           120 |                           20 |                         32 |
| Game/room creation and creation-operation issuance            |           240 |                           30 |                         32 |
| Moves, AI turns, history deletion, invitation changes         |          6000 |                          600 |                         64 |
| AI controller and lifecycle/recovery commands                 |          4800 |                          240 |                         64 |
| Game, room, history, invocation, profile and credential reads |         12000 |                         1200 |                        128 |
| Credential and profile writes                                 |           240 |                           30 |                         32 |
| Analysis reads                                                |          4800 |                          600 |                         64 |
| Analysis uploads                                              |          9600 |                         2400 |                         64 |
| Invitation resolution                                         |            30 |                            — |                         32 |
| Invitation join                                               |           120 |                           30 |                         32 |
| Socket handshakes                                             |           240 |                           60 |  See connection caps below |
| Other requests, including public probes/unknown routes        |           120 |                            — |                         32 |

Each traffic category has independent IP and identity stores capped at 4096 entries each. Expired entries are reclaimed on admission; a full store rejects new identities until an entry expires, without evicting an active quota. Counter keys contain only normalized addresses/internal IDs and fixed categories. Request slots are released on response completion, timeout or connection closure. Loopback health/readiness probes and CORS preflight do not consume application budgets. All application counters and socket state are local to the one API process and reset on restart. Do not scale instances to bypass the policy; shared limiting would need a separate deployment decision.

The existing Better Auth endpoint limits remain database-backed and survive API restarts. The bridge also prunes counters older than the longest configured auth window before admitting work, at most once per minute, including requests from previously unseen addresses. Its finite endpoint allowlist, capped IP admission and expiry bound counter growth; pruning failure prevents new auth work. These controls do not define guest/game retention or delete account records.

Sockets allow 1024 connections per API and 96 per IP budget, including pending authorization, with eight per verified identity after authorization. The existing five-second handshake/subscription/delivery deadlines, 4 KiB subscription, 1 MiB output buffer and heartbeat/reconciliation limits remain. Each subscription permits at most 32 fragments/32 buffered input chunks. A socket accepts one subscription; further data messages close it. Ping/pong traffic is capped at 60 frames per ten seconds; automatic pong replies are disabled so floods cannot trigger unbounded responses. Floods close only that socket with policy code 1008. Rejected handshakes return 429 and `Retry-After`; browsers cannot inspect upgrade responses and retain their five bounded reconnect attempts followed by explicit Retry.

Application rejections return safe `RATE_LIMITED` JSON, `no-store` and an integer `Retry-After` (remaining window, or one second for occupied request/socket capacity), exposed through CORS. They do not invoke providers or change chess state. Provider quota failures retain their existing provider error/pause behavior. Browser transports share at most 64 endpoint cooldowns per identity lifetime (or public page scope) in page memory, surviving route-client recreation and clearing on identity abort, discard 429 bodies, and never automatically resend writes. Invocation polling waits for the cooldown; analysis failures retain unsaved samples and require explicit persistence Retry. Move/command retries preserve their IDs, including a 429 after an earlier lost acknowledgement. Controller/recovery capacity is separate from reads, discovery and analysis. Eight-tab polling, room participants sharing NAT, analysis backfill and reconnect bursts are regression-tested; these are application admission bounds, not a distributed denial-of-service guarantee.

## Browser and response security

Caddy's `deploy/Caddyfile` applies the production policy to static documents/assets and API responses, including missing assets and proxy failures. The API also applies its JSON policy before route-specific responses, including early admission failures and CORS preflight. All API/auth responses are `Cache-Control: no-store`; Caddy enforces this again after upstream headers. Do not add a cache/CDN in front of private responses. Static HTML contains no account data and revalidates; hashed assets remain immutable and versioned engine assets retain their existing cache lifetime. Static errors are `no-store`.

The web CSP defaults to no sources. Scripts, styles, fonts and workers load only from the web origin. `script-src` permits `wasm-unsafe-eval` for the pinned Stockfish worker, without JavaScript `unsafe-eval`, inline scripts, blob workers or remote scripts. API fetches use the exact `BETTER_AUTH_URL`; Caddy derives its matching WSS origin for private sockets. Build `VITE_API_BASE_URL` with that same origin. Images may use the web origin, HTTPS `googleusercontent.com` and its subdomains, or `avatars.githubusercontent.com`; the existing profile contract further validates provider URLs. Changing an origin, engine flavor or image provider requires a production browser rehearsal. [CSP WASM policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src#unsafe_webassembly_execution), [Caddy headers](https://caddyserver.com/docs/caddyfile/directives/header).

Both origins send `nosniff`, deny framing, forbid base-URL changes, and use `Referrer-Policy: no-referrer`. Permissions Policy disables camera, microphone, geolocation, payment and USB; it leaves invitation clipboard functionality available. HTTPS responses send one year of HSTS for the current hostname, without preload or `includeSubDomains` commitments for other hosts. `Cross-Origin-Opener-Policy: same-origin` isolates openers; the application uses full-page OAuth navigation. Resources use `Cross-Origin-Resource-Policy: same-origin` on the web and `same-site` on the API. There is no COEP requirement: the accepted single-threaded engine needs no SharedArrayBuffer, and provider avatars need not opt into embedding. [Opener policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy).

Caddy access/error-request logs remain disabled; API request logs omit query/fragment and auth protocol paths and never include request headers/bodies. Invitation fragments are consumed in page memory, and callbacks redirect only to token-free app URLs. Do not enable raw request logging or CSP reporting endpoints that collect private document URLs. The rehearsal checks callback/invitation canaries against both services' logs and checks referrers during avatar and OAuth navigation.

Browser startup configures Zod's `jitless` mode before constructing schemas, avoiding its JavaScript-evaluation probe under CSP. The production rehearsal requires normal page/worker activity to produce no policy violations and checks blocked inline scripts, external images and connections. Avatar images and Google/GitHub consent pages are intercepted fixtures; auth initiation, state cookies and cancellation redirects use the compiled API. This verifies browser policy compatibility, not live consent or successful external token exchange.

## Dependency and asset review

Run `npm audit --omit=dev` and `npm audit` against the release lockfile; required CI runs both and fails on any reported advisory or registry failure. For each finding, inspect the affected installed version, production/build/test use, attacker-controlled inputs and actual reachable behavior. Apply a targeted stable fix, then rerun the relevant tests and both audits. Never use blanket force upgrades. An exception requires a documented bounded exposure, remediation owner and follow-up date in the reviewed change; it must not silently lower the CI threshold. A clean advisory audit does not establish that all code or container/OS packages are vulnerability-free. The operator also owns supported base images and host patching.

Production web builds emit `THIRD-PARTY-NOTICES.md` from Vite's bundled dependency inventory, including the installed Inter/Orbitron copyright and SIL OFL text. JavaScript banners identify that file. The versioned engine directory continues to include hash-verified JS/WASM, corresponding source, network, build inputs and GPL notices; its in-app source/license link remains available. Build tests inject private-environment canaries and reject their appearance in emitted assets, or inclusion of Sandbox/reference/test modules. The production rehearsal verifies the served notices and engine hashes and the unavailable test/Sandbox routes. These are packaging checks: the owner's repository-license decision and application/engine compatibility review in [ADR-0019](decisions/0019-browser-analysis-and-private-samples.md#distribution-and-licensing) still gate public distribution.

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

The API accepts at most 1 MiB globally, with existing narrower route limits. Inbound requests have a 30-second receipt timeout; idle connections have a 210-second timeout and HTTP keep-alive is five seconds. Caddy has a ten-second header timeout and a 210-second upstream response-header timeout, retaining the longer AI operation budget. Request limits and browser policies are specified above. Docker log rotation is bounded. Operational alerting remains P5-13.

Run local proof with Docker, OpenSSL and all three Playwright browsers installed:

```text
npm run build:deployment:test
npm run test:deployment
```

The rehearsal creates its own project, generated TLS/secrets, PostgreSQL volume and TLS mailbox, and removes them afterward. It exercises real compiled services, static routing/MIME/cache rules, SMTP registration, secure sessions, private rooms and sockets through Caddy, worker/WASM loading in Chromium/Firefox/WebKit, populated migrations, graceful restart and database failure/recovery. Set `DEPLOY_ROLLBACK_API_IMAGE` to a locally retained prior-release image to additionally verify that the prior binary can read the populated schema and sessions, then return to the new binary. Only test a release whose compatibility has been reviewed; passing an identical new image does not establish backward compatibility. Its local browser certificate exception and mailbox are test-only mounts; they are absent from production images/configuration. No outbound mail or inference is required. CI repeats the current-image rehearsal on AMD64 and ARM64 without publishing images or private artifacts.

Before public release, still verify actual Oracle capacity/networking, domain ownership and public TLS, both OAuth consents, SMTP inbox delivery, provider calls, and same-site cookies/sockets on the live host. Configure OCI monitoring/alerts in P5-13 and agree/test database backup retention, separate secret recovery and restoration in P5-14. OCI volume backups/object storage are available within quotas, but no successful backup or restore is claimed here. Complete the physical-browser/accessibility and licensing gates in P5-15.
