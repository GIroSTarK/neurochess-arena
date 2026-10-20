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

Caddy access/error-request logs and automatic API request logs remain disabled. API diagnostics use fixed events, allowlisted error names/codes and process-local request IDs; they omit request headers/bodies and redact private fields and game paths. Invitation fragments are consumed in page memory, and callbacks redirect only to token-free app URLs. Do not enable raw request logging or CSP reporting endpoints that collect private document URLs. The rehearsal checks callback/invitation canaries against both services' logs and checks referrers during avatar and OAuth navigation.

Browser startup configures Zod's `jitless` mode before constructing schemas, avoiding its JavaScript-evaluation probe under CSP. The production rehearsal requires normal page/worker activity to produce no policy violations and checks blocked inline scripts, external images and connections. Avatar images and Google/GitHub consent pages are intercepted fixtures; auth initiation, state cookies and cancellation redirects use the compiled API. This verifies browser policy compatibility, not live consent or successful external token exchange.

## Dependency and asset review

Run `npm audit --omit=dev` and `npm audit` against the release lockfile; required CI runs both and fails on any reported advisory or registry failure. For each finding, inspect the affected installed version, production/build/test use, attacker-controlled inputs and actual reachable behavior. Apply a targeted stable fix, then rerun the relevant tests and both audits. Never use blanket force upgrades. An exception requires a documented bounded exposure, remediation owner and follow-up date in the reviewed change; it must not silently lower the CI threshold. A clean advisory audit does not establish that all code or container/OS packages are vulnerability-free. The operator also owns supported base images and host patching.

Production web builds emit `THIRD-PARTY-NOTICES.md` from Vite's bundled dependency inventory, including the installed Inter/Orbitron copyright and SIL OFL text. JavaScript banners identify the license page that links to that file. The versioned engine directory continues to include hash-verified JS/WASM, corresponding source, network, build inputs and GPL notices; its in-app source/license link remains available. Build tests inject private-environment canaries and reject their appearance in emitted assets, or inclusion of Sandbox/reference/test modules. The production rehearsal verifies the served notices and engine hashes and the unavailable test/Sandbox routes. The application uses GPL-3.0-only under [ADR-0021](decisions/0021-project-license-and-source-distribution.md). Each web build also packages its application build sources, GPL text and supplemental notices, linked from every footer. Verify anonymous access to these artifacts on the public origin before release, following the [licensing policy](licensing.md).

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

Build natively on ARM64 or use `docker buildx build --platform linux/arm64 --load` when preparing Oracle images elsewhere. Never transfer an AMD64-only image to the A1 host. Preserve previous API/web images for rollback and record their image IDs. Image publication is not part of the build commands or CI. Keep each build's source archive, engine inputs and notices with its web artifacts. Public source/notice verification follows the [licensing policy](licensing.md).

Use the same Compose project name, configuration revision and secret directory for every release. Run these commands from the release checkout, after setting the desired image tags in the external deployment environment:

After [promoting a recovered volume](recovery.md#promote-the-recovered-volume), append `-f deploy/recovery/promote.override.yml` after `-f deploy/compose.yml` on every command below. Preserve the selected `RECOVERED_VOLUME`, recovered database URL and backup target together; the base configuration alone targets the original production volume.

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

The API accepts at most 1 MiB globally, with existing narrower route limits. Inbound requests have a 30-second receipt timeout; idle connections have a 210-second timeout and HTTP keep-alive is five seconds. Caddy has a ten-second header timeout and a 210-second upstream response-header timeout, retaining the longer AI operation budget. Request limits and browser policies are specified above. Docker log rotation is bounded; the operational policy follows below.

Run local proof with Docker, OpenSSL and all three Playwright browsers installed:

```text
npm run build:deployment:test
npm run test:deployment
```

The rehearsal creates its own project, generated TLS/secrets, PostgreSQL volume and TLS mailbox, and removes them afterward. It exercises real compiled services, static routing/MIME/cache rules, SMTP registration, secure sessions, private rooms and sockets through Caddy, worker/WASM loading in Chromium/Firefox/WebKit, populated migrations, graceful restart and database failure/recovery. Set `DEPLOY_ROLLBACK_API_IMAGE` to a locally retained prior-release image to additionally verify that the prior binary can read the populated schema and sessions, then return to the new binary. Only test a release whose compatibility has been reviewed; passing an identical new image does not establish backward compatibility. Its local browser certificate exception and mailbox are test-only mounts; they are absent from production images/configuration. No outbound mail or inference is required. CI repeats the current-image rehearsal on AMD64 and ARM64 without publishing images or private artifacts.

Before public release, complete the [MVP release acceptance](#mvp-release-acceptance) below. Local fixtures do not establish live-service or physical-device readiness.

For Google OAuth branding, publish `/privacy.html` and `/terms.html` with the
same web release, then verify that both return their document text without
authentication or JavaScript and that homepage links reach them. Use their full
HTTPS URLs on the public web origin in Google Console, not `licensing.html` or
an SPA fallback. Confirm the operator/contact address, hosting/email providers,
and retention statements match the live deployment before publishing. The public
pages are generated from `apps/web/src/i18n/legal-en.ts`; updating them does not
itself deploy the site or complete Google's branding verification.

## MVP release acceptance

Use this checklist for one identified release candidate. The [eight product criteria](product.md#mvp-acceptance-criteria) are the exit condition; the [roadmap](roadmap.md#phase-5--analysis-polish-and-release-hardening) records current completion. A pending check blocks release even when local tests pass. Keep dated results, commands, exact revision, dirty-diff identity (if any), OS/Node/npm/browser versions, image IDs and evidence links in the reviewed change or private release record, not this runbook. After a candidate changes, rerun affected checks; before approval, establish evidence for the final immutable revision and images.

### Evidence map

The suites below provide repeatable evidence, not an automatic sign-off. Paths are relative to the repository; browser specs are under `test/e2e/` and API integration suites under `apps/api/test/`.

| Product criterion                                      | Automated evidence to inspect                                                                                                                                                                            | Additional release evidence                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Three end-to-end game modes                         | `ai-match.spec.ts`, `ai-human.spec.ts`, `rooms.spec.ts`, `room-recovery.spec.ts`; API `ai-human.integration.test.ts`, `room-commands.integration.test.ts`                                                | All three modes on the [physical browser matrix](development.md#physical-browser-release-matrix), including mobile/background recovery.                                         |
| 2. Four providers discover models and play legal turns | API `provider-matrix.integration.test.ts`, provider-specific integration suites and `providers/*.test.ts` exercise real adapters with injected HTTP responses                                            | Explicitly authorized bounded discovery/legal-turn checks for OpenAI, Anthropic, Google and OpenRouter, recording actual model IDs and safe outcomes.                           |
| 3. Independent AI seats and live controls              | `ai-setup.spec.ts`, `ai-match.spec.ts`, `ai-telemetry.spec.ts`; API `ai-controller.integration.test.ts`, `ai-failure-policy.integration.test.ts`                                                         | Usable seat configuration, pause/resume/step/speed/stop and explicit recovery on target devices.                                                                                |
| 4. Account, room and private-history lifecycle         | `accounts.spec.ts`, `account-acceptance.spec.ts`, `account-deletion.spec.ts`, `history.spec.ts`, `room-entry.spec.ts`, `room-privacy.spec.ts`, `room-recovery.spec.ts`; API session/deletion/race suites | Real Google/GitHub consent and callbacks, email verification/reset inbox delivery, and selected-host sessions, invitations and reconnects.                                      |
| 5. Saved replay, analysis, telemetry and PGN           | `analysis.spec.ts`, `evaluation.spec.ts`, `ai-telemetry.spec.ts`, `history.spec.ts`, `clipboard.spec.ts`; API analysis/deletion/cost suites; production worker/MIME/hash checks                          | Public worker/source/notices availability, native clipboard/download, real-device analysis recovery and the deployed application source/license download.                       |
| 6. Session-only and saved-key security                 | `credentials.spec.ts`; API `credentials.integration.test.ts`, `saved-credential-operations.integration.test.ts`; production bundle/redaction and encrypted recovery checks                               | Review deployed secret storage, opt-in encryption, independent key recovery, private logs and Secure cookies against [ADR-0004](decisions/0004-bring-your-own-key-security.md). |
| 7. Critical automated coverage                         | `npm run verify`, `npm run db:check`, the complete `npm run test:e2e` matrix, performance, smoke, deployment and recovery commands below                                                                 | All required CI checks green for the candidate; final advisory/security review, with unresolved blockers recorded.                                                              |
| 8. Coherent accessible UI without release blockers     | `accessibility.spec.ts`, `keyboard-moves.spec.ts`, `arena-states.spec.ts`, `responsive-analysis.spec.ts`, rendered-contrast assertions and production performance budgets                                | Actual reader speech, browser/OS zoom, mobile keyboards, safe areas and physical-device performance; resolve blockers in the [validation limits](design-system/validation.md).  |

### Release checklist

- [ ] From a clean candidate checkout, run `npm ci`, `npm run db:check` and `npm run verify` on the [supported runtime](development.md#local-setup). Verify **empty**, populated and repeated migration paths on disposable databases: integration setup reapplies the journal twice and populated migration suites preserve prior data; the deployment rehearsal creates a fresh database and reruns migrations after inserting application records. Do not point acceptance tools at production or use an existing populated database as proof of an empty install.
- [ ] Run all five projects with `npm run test:e2e`, plus `npm run test:performance` and `npm run smoke`. Follow the [Linux browser-server instructions](development.md#running-acceptance) on Windows. Keep integration, browser, performance and smoke runs sequential because their harnesses share ports. Record collection counts, project results and any failures; rerunning only failures is diagnostic evidence, not a substitute for a clean affected-suite run. CI's scheduled Firefox/WebKit cadence does not waive the complete release matrix.
- [ ] Run `npm run build:deployment:test`, `npm run test:deployment` and `npm run test:recovery`. Include a reviewed, genuinely prior `DEPLOY_ROLLBACK_API_IMAGE` for populated-schema application rollback, then verify return to the candidate. Inspect the stop/drain/migrate/restart procedure and single API owner, recovery promotion and subsequent encrypted backup. Record AMD64/ARM64 evidence for the actual target; local AMD64 fixtures do not establish Oracle ARM64 capacity or the production-size two-hour recovery target. Follow [recovery reconciliation](recovery.md#reconcile-and-validate-before-reopening) before reopening restored data.
- [ ] Run `npm audit --omit=dev` and `npm audit` against the final lockfile, review reachable findings and resolve release blockers. Review supported host/base images, production secret configuration, exact origins/TLS and private response/log policies. Verify the [GPL-3.0-only distribution policy](licensing.md): publish the intended source revision and confirm anonymous access to the deployed application source archive, license, dependency/font notices and exact engine source/network/notices. Preserve the corresponding materials for every distributed release.
- [ ] Complete every row of the [physical browser release matrix](development.md#physical-browser-release-matrix) and the [accessibility checklist](design-system.md#accessibility-and-acceptance). Record exact device/OS/browser/reader versions and observed speech through authentication, setup/key recovery, board/promotion, rooms, dialogs, graph/table selection, history and export. Exercise real zoom, mobile-keyboard viewport changes, rotation/safe areas, swipe/scroll and background/restore. Record unavailable systems as pending, never as emulation passes.
- [ ] On the selected live host, verify public certificate trust, same-site Secure/HttpOnly cookies, proxy identity/limits, private response policy, Google and GitHub consent/callbacks, SMTP verification/reset inbox delivery, public worker/WASM loading and private WebSocket reconnect after a controlled API restart. Check with dedicated test identities in an approved maintenance window; fixtures and self-signed local TLS do not establish this gate.
- [ ] Obtain explicit authorization and user-supplied credentials for each provider's live check, including model IDs, discovery-request caps, inference-attempt caps and maximum spend. Limit the check to one logical legal turn per provider, allowing at most the existing three attempts and no automatic repeat after a provider pause. Bound discovery and disable autoplay; stop on the agreed cap or failure. Record provider/model, date, legal-move validation and normalized usage/error classification only. Keep paid calls out of default tests; never retain keys, auth headers, cookies, raw provider payloads or credential-bearing browser artifacts.
- [ ] Activate [private monitoring](#operational-monitoring) and verify OCI ingestion, owner notification delivery, firing/recovery and collector-absence alerts. Verify live backup bucket IAM/readback, daily scheduling, seven-day expiry, retrieval from the independent secret store, deletion/revocation reconciliation, and an isolated restore of representative data within the agreed 24-hour RPO/two-hour RTO. Confirm a successful backup after promotion. A local storage fixture or generated alarm definition does not close these gates.
- [ ] Review every criterion and unresolved defect with the release owner. Split substantial new defects into explicit additional PRs; fix small blockers with focused regressions. Leave Phase 5 incomplete while any live/manual/licensing/operational prerequisite remains. Only after all evidence passes may the owner approve production release and the roadmap be marked complete.

## Backups and recovery

The canonical [recovery runbook](recovery.md) defines the owner-selected daily backups, 24-hour RPO, two-hour RTO, seven-day expiry, separate secret recovery and isolated restore/reconciliation procedure. It also preserves the existing shared-room cleanup and formalizes 24-hour sliding guest access without adding solo-guest purging. Use `npm run test:recovery` for a real encrypted populated restore drill. Local evidence does not establish live cloud activation or full-size disaster recovery.

## Operational monitoring

The deployment owner responds to alerts and maintains the OCI Notifications subscription. The application records fixed numeric counters for HTTP outcomes/latency, analysis persistence, normalized provider failures and room synchronization/connection churn. It samples database readiness/pool waits, RSS and event-loop utilization. Startup, listening, readiness transitions and stopping have fixed structured events. Provider authentication/quota failures, invalid model output, cancellation and HTTP client rejections are separate from infrastructure failures. There are no model, account, game, invitation, IP or URL dimensions and no prompts, commentary, positions or raw exceptions in monitoring payloads. A telemetry failure cannot change a game result or trigger inference retries.

`GET /internal/operations` returns the validated aggregate snapshot only to a direct loopback peer without Origin or forwarding headers. Caddy and other container/network peers receive 404, even with forged loopback forwarding. The collector uses `docker exec` to read that endpoint; no extra port or public dashboard is exposed. The process retains a fixed set of counters/gauges, with reset detection across restarts. Public health/readiness checks do not inflate server-error counters. Mean latency covers completed operations; slow-request counts exclude discovery/AI turns. Room synchronization failures include reconnect attempts, without tracking a person's reconnect history.

`scripts/monitoring/run.ts` is a Node 24 host collector using built-ins only. Every minute it samples the API, checks the configured web/API HTTPS origins with normal certificate verification, reads filesystem capacity and bounded backup status, then publishes one atomic batch to the Frankfurt OCI ingestion endpoint using the OCI CLI and instance-principal authentication. Only `service=arena` is exported as a dimension. Subprocess output is capped at 32 KiB with a 20-second deadline; stderr is discarded. Collections never overlap; there is no queue, replay or disk spool. Export errors produce fixed state transitions, and a separate cloud heartbeat absence alarm detects a stopped collector, VM or broken export path. [OCI custom metrics](https://docs.oracle.com/en-us/iaas/Content/Monitoring/Tasks/publishingcustommetrics.htm).

The private dashboard and `status.json` retain only the latest snapshot in `/var/lib/neurochess-monitor`, mode 0600 in a 0700 directory. Read the dashboard locally over trusted SSH file transfer; do not serve it from Caddy. Its timestamp is stale after 90 seconds. First collection and the first sample after an unavailable scrape establish a counter baseline; no missing interval is reported as measured zero activity. In-memory alert state resets when the collector restarts. Docker retains three 10 MiB log files per service. The collector's separate journal namespace is limited to 30 MiB on disk/10 MiB at runtime and seven days. OCI retains metric definitions and alarm history for 90 days, with query resolution limits; there is no application export archive. Restrict metric/dashboard/topic access to operators and expire delivered alert mail under the operator's mailbox policy. [OCI storage limits](https://docs.oracle.com/en-us/iaas/Content/Monitoring/Concepts/monitoringoverview.htm#storage), [journal retention](https://www.freedesktop.org/software/systemd/man/252/journald.conf.html).

| Alert                             | Local trigger                                                                                             | First response                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| API unavailable                   | Internal scrape or public web/API HTTPS unavailable for 2 minutes                                         | Check Caddy/TLS, container exit status, rollout and liveness; preserve one API owner.                     |
| Database unavailable              | API reachable but database probe fails for 2 minutes                                                      | Check PostgreSQL health, TLS expiry, disk and pool waits; preserve volumes and secrets.                   |
| Server failures                   | At least 5 HTTP 5xx per collection for 2 minutes                                                          | Compare readiness and fixed error codes with the release; use only a schema-compatible rollback.          |
| Resource pressure                 | RSS ≥900 MiB, event-loop utilization ≥90%, pool waiters, disk ≥85% or ≥900 room connections for 5 minutes | Inspect resource usage, stop nonessential work and investigate capacity; do not add another socket owner. |
| Provider failures                 | At least 3 timeouts/unavailable outcomes per collection for 2 minutes                                     | Check provider status/egress; leave user-directed paused retry intact.                                    |
| Room recovery failures            | At least 5 failures/timeouts or 30 disconnects per collection for 2 minutes                               | Check database/API availability, proxy upgrades and connection pressure; clients resynchronize.           |
| Analysis failures / slow requests | At least 5 analysis 5xx for 2 minutes / 10 non-provider requests over 2 seconds for 5 minutes             | Inspect database waits and resource pressure; preserve independent chess/retry behavior.                  |
| Backup failed / unknown           | Failed/stale evidence / missing, malformed, future-dated evidence or missing agreed cadence               | Inspect the backup job/destination or complete the backup setup; preserve the last good copy.             |
| Monitoring absent                 | Cloud receives no heartbeat for 5 minutes                                                                 | Check VM, collector, IAM/OCI ingestion and notification delivery independently of application health.     |

The local evaluator requires consecutive observations, emits one firing/resolved transition and preserves an already-firing incident across a sampling gap. OCI applies an additional one-minute trigger delay to local alert gauges, repeats firing notifications hourly and sends recovery notifications. The absence query uses the maximum 72-hour detection period; an OCI `RESET` after that period is **not recovery**. Confirm a fresh heartbeat and service probes before closing an incident. [OCI absence semantics](https://docs.oracle.com/en-us/iaas/Content/Monitoring/Tasks/create-alarm-absence.htm).

### Install and activate monitoring

Install the pinned project Node 24 baseline at `/usr/bin/node` and the supported OCI CLI in the host PATH. Put the reviewed checkout at `/opt/neurochess`. The collector needs Docker administration to run the fixed scrape command; its service is therefore operator/root-owned. Its read-only filesystem protections do not turn Docker access into an unprivileged sandbox. It receives no application secrets or database credentials.

In OCI, create a dynamic group containing only this VM and grant `use metrics` in the selected compartment, restricted to `target.metrics.namespace='neurochess_ops'`. Give the human operator metric-read, alarm-management and Notifications-topic permissions; do not grant the VM alarm-management privileges. Create a private Notifications topic and confirm the deployment owner's subscription. Verify actual free quotas before activation; publishing/notification delivery is a live operator action. [Metric access example](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/transitioning-to-hpc-plugin.htm#required-policies-for-rdma-gpu-monitoring).

Copy `deploy/monitoring/config.example.json` to `/etc/neurochess/monitor.json`, mode 0600. Set the real compartment/topic OCIDs, container name, exact HTTPS origins and paths. For the root compartment, use the tenancy OCID (`ocid1.tenancy.oc1..…`); a child compartment uses `ocid1.compartment.oc1..…`. The agreed `backupMaxAgeSeconds` is 86400. The [backup job](recovery.md#configure-and-run-backups) atomically replaces the operator-only status file with `status` (`success` or `failure`) and UTC `startedAt`/`completedAt` timestamps, without paths, command output or secrets. Age is measured from snapshot start; older evidence without `startedAt` uses completion time. Missing, invalid or future-dated evidence remains unknown. This interface does not by itself schedule a backup or establish recoverability.

Prepare local alarm definitions and install the service:

```sh
node scripts/monitoring/run.ts configure /etc/neurochess/monitor.json
install -m 0644 deploy/monitoring/journald.conf /etc/systemd/journald@neurochess-monitor.conf
install -m 0644 deploy/monitoring/neurochess-monitor.service /etc/systemd/system/neurochess-monitor.service
systemctl daemon-reload
systemctl enable --now neurochess-monitor
journalctl --namespace=neurochess-monitor -u neurochess-monitor --since '10 minutes ago'
```

The configure command writes eleven fixed alarm JSON files beside the dashboard, without contacting OCI. Review them and create each once with the operator's OCI identity, for example `oci monitoring alarm create --from-json file:///var/lib/neurochess-monitor/ApiUnavailable.json`. Record the returned alarm IDs in protected deployment configuration and use `oci monitoring alarm update --alarm-id ... --from-json ... --force` for later policy updates, omitting create-only compartment fields; do not create duplicate alarms. Never use the VM identity to administer notifications.

For cloud history, configure a private OCI Console dashboard in Frankfurt with namespace `neurochess_ops`, dimension `service=arena`, one-minute refresh and a one-hour range. Use Monitoring widgets for availability (`apiAvailable`, `edgeAvailable`, `databaseReady`, `Heartbeat`, minimum), failures (`serverFailures`, `providerFailures`, `roomFailures`, `analysisFailures`, maximum), resources (`rssBytes`, `eventLoopUtilization`, `poolWaiting`, `diskUsedPercent`, maximum), and backup evidence (`backupFailure`, `backupUnknown`, maximum). Add separate widgets for the desired metrics; each name comes from the tested collector. No log/search widget is needed. [OCI widget setup](https://docs.oracle.com/en-us/iaas/Content/Dashboards/Tasks/widgetmanagement.htm).

Before release, verify ingestion, dashboard visibility and actual firing/recovery delivery to the owner's subscription. Stop the collector long enough to trigger the absence alarm, then restart and confirm a new heartbeat; check mail delivery as well as OCI alarm state. Repeat API/database interruption and recovery in isolation, never against live games without a maintenance window. Unit/integration drills cover all alert conditions, backup evidence, redaction and export failures; the production rehearsal exercises compiled provider deadlines, real PostgreSQL stop/recovery and API restart with three browser engines. Local policy clocks are accelerated for those assertions; no local fixture proves OCI delivery, live host monitoring or backup restoration.
