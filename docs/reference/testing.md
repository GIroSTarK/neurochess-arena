# Testing and acceptance reference

Use the [development guide](../development.md#verification) for the required contribution baseline. This reference owns test-environment setup, focused browser suites, CI evidence and the physical-browser release matrix. Live release acceptance follows the [operations checklist](../operations.md#mvp-release-acceptance).

| Task                                         | Start here                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run focused logic or component checks        | [Unit test environments](#unit-test-environments)                                                                                                |
| Provision disposable data or verify upgrades | [PostgreSQL integration tests](#postgresql-integration-tests), [fresh-install and migration acceptance](#fresh-install-and-migration-acceptance) |
| Select a browser or prepare a release matrix | [Supported versions](#supported-browsers-and-version-policy), [physical browser checks](#physical-browser-release-matrix)                        |
| Run gameplay acceptance                      | [Focused suites](#running-acceptance), [browser installation](#browser-installation), [Windows browser server](#windows-browser-server)          |
| Inspect test failures or workflow results    | [Test server and artifacts](#test-server-and-artifacts), [CI workflows and evidence](#ci-workflows-and-evidence)                                 |
| Check account lifecycle coverage             | [Account acceptance](#account-lifecycle-acceptance)                                                                                              |

## Unit test environments

`npm run test:unit` runs both projects in `vitest.config.ts`. Select one with
`npm run test:unit -- --project=node` or `npm run test:unit -- --project=web`.
The `node` project includes API, package, web build, and explicitly audited
DOM-independent frontend tests; it does not load the web DOM setup. The `web`
project uses jsdom and `apps/web/src/test/setup.ts` for the remaining frontend tests,
including components, hooks, navigation, and page-memory credentials.

Keep `webNodeTestFiles` as the shared inclusion/exclusion allowlist. When splitting
a listed test such as `sandbox/controller.commands.test.ts`, audit each resulting file's imports
and exercised browser APIs before adding its exact path; unlisted frontend tests
stay in jsdom regardless of `.ts` or `.tsx` extension. Both unit projects exclude
`*.integration.test.ts`, which belongs only to the PostgreSQL configuration.

## PostgreSQL integration tests

Add `TEST_DATABASE_URL` from `.env.example` if updating an existing `.env`, then run:

```text
npm run infra:test:up
npm run test:integration
npm run verify
```

The test service binds loopback port 5433 and uses tmpfs instead of the development volume. Its data is disposable when the container stops. Tests require an explicit PostgreSQL URL whose database name ends in `_test` and reject connection-level `options`; they never fall back to `DATABASE_URL`. Global setup applies reviewed migrations twice. Fixtures use unique guest IDs and cleanup deletes only those guests' games and sessions, not whole tables. Concurrent scenarios use independent pools/API instances, and rollback tests fail after an actual SQL insert. Tests never silently skip when PostgreSQL is unavailable.

CI uses its own ephemeral `neurochess_test` database and runs integration tests through `npm test`. Unit tests and architecture checks remain runnable without PostgreSQL. Keep `TEST_DATABASE_URL` pointed only at a dedicated disposable database, never shared or production data.

Historical migrations have focused suites under `packages/database/test`: `legacy-game-migration`, `account-migration`, `credential-migration`, and `room-foundation-migration`. Run a file independently, or select a migration by its numbered test name, for example `npm run test:integration -- packages/database/test/credential-migration.integration.test.ts -t 0013`. The `historical-upgrade.integration.test.ts` suite retains the populated `0001`–`0018` path; `persistence.integration.test.ts` and integration setup still verify repeated migration application. The shared schema fixture rolls back on failures and drops its schema on success.

## Browser tests

For a release candidate, use the [MVP release acceptance checklist](../operations.md#mvp-release-acceptance) to combine this browser matrix with migrations, production artifacts, recovery, live-service and manual evidence. A green development harness alone does not establish release readiness.

### Supported browsers and version policy

Release targets are the current stable Chrome, Edge and Firefox on vendor-supported
desktop Windows, macOS and Linux; current stable Safari on macOS and iOS; and current
stable Chrome on Android. Older releases, Firefox ESR and embedded/in-app browsers
are outside the declared matrix. Record exact OS and browser versions when performing
release checks; a new stable release must be rechecked before claiming support.

The automated baseline uses the exact `@playwright/test` version in `package-lock.json`
and its matching bundled browser revisions, installed with `npm exec playwright -- install`.
Update Playwright and all installed engines together, rerun the complete matrix, and
review failures before accepting the update. Bundled engines are reproducible compatibility
checks; they do not certify branded browsers or physical devices. See
[Playwright browser support](https://playwright.dev/docs/browsers).

| E2E project        | Engine/device             | Default viewport | Coverage                                    |
| ------------------ | ------------------------- | ---------------- | ------------------------------------------- |
| `chromium-desktop` | Desktop Chrome            | 1440×1080        | Full suite, including controller protocol   |
| `chromium-mobile`  | Pixel 7 touch emulation   | 390×844          | Full suite except desktop controller timing |
| `firefox-desktop`  | Desktop Firefox           | 1440×1080        | Full suite, including controller protocol   |
| `webkit-desktop`   | Desktop Safari engine     | 1440×1080        | Full suite, including controller protocol   |
| `webkit-mobile`    | iPhone 13 touch emulation | 390×844          | Full suite except desktop controller timing |

Every project covers all three public modes, email/OAuth fixture journeys, Secure
session cookies, saved and page-memory credentials, room WebSockets/reconnection,
private replay/PGN, real Stockfish JS/WASM and failure recovery, and estimated/incomplete
cost views. Desktop projects add the tagged long controller-lease timing scenarios;
both mobile projects retain refresh, key recovery, socket recovery and touch play.
Mobile WebKit does not expose Playwright's mouse-wheel API, so its page/list/replay
scroll checks use native keyboard input and preserve the same scroll, selection and
focus assertions. Tap gameplay still runs; physical swipe and scroll chaining remain
release checks below.
Performance measurement remains the separate Chromium `desktop`/`mobile-touch`
matrix in `playwright.performance.config.ts` because its CPU/heap probes use CDP.

### Physical browser release matrix

For each release candidate, perform and record these checks with exact device,
OS/browser version, revision, observed results and unresolved defects. Acceptance
status is tracked in the [roadmap](../roadmap.md#phase-5--analysis-polish-and-release-hardening).

| System                      | Required release checks beyond emulation                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS Safari                | All public modes, native clipboard/download, Secure sessions, sockets after background/restore, real worker loading, browser/OS zoom, VoiceOver                                                               |
| Physical iPhone/iPad Safari | Portrait/landscape, safe areas, on-screen keyboard with sign-in/key entry, tap/promotion/dialogs, swipe and scroll chaining, clipboard/export, background/reconnect and analysis recovery, zoom and VoiceOver |
| Physical Android Chrome     | The same mobile journeys, on-screen keyboard/viewport resizing, downloads, background throttling and analysis recovery, zoom and TalkBack                                                                     |
| Desktop Chrome/Edge/Firefox | Current branded versions, real zoom and keyboard journeys, available NVDA/JAWS/Narrator checks on Windows                                                                                                     |

Use the [accessibility acceptance checklist](../design-system.md#accessibility-and-acceptance)
and [validation limits](../design-system.md#validation-limits). Mobile engine emulation and root-text
enlargement do not verify Safari/iOS hardware, OS zoom or virtual keyboards. Live OAuth,
SMTP and production TLS/proxy checks remain separate release gates.

### Running acceptance

Run `npm run test:e2e -- test/e2e/rooms.spec.ts test/e2e/room-privacy.spec.ts test/e2e/room-recovery.spec.ts` for private-room acceptance in independent desktop/mobile browser contexts. The suites cover either owner color with account/guest opponents, matching final FEN/result and downloaded PGN, keyboard/touch play, promotion, maximum-length names, focus and announcements, participant history/deletion, account deletion during play, outsider HTTP/socket denial, consumed invitations, public-slot conflicts and independent Sandbox use. Recovery cases include refresh after multiple moves, all tabs disconnecting, duplicate/older socket events, delayed or lost HTTP acknowledgements, offline-opponent closure and identity switching.

These browser tests use the real room/auth services and disposable PostgreSQL. Delivery-fault tests hold HTTP replies, replay previously received frames or interrupt socket delivery while commands still use the real service. Room controller/store/client and route tests cover bounded reconnect, stale decisions, invitation handoffs and late-response fencing. Run `npm run test:integration -- apps/api/test/room apps/api/test/participant-slots.integration.test.ts` for the complementary PostgreSQL/native-socket proof: standard draw/history restoration, a new API process after a crash, missed-publication reconciliation, competing admission and both AI modes, idle session revocation/expiry, account deletion races and renewal-safe guest cleanup. Keep integration and browser runs sequential because their lifecycle checks share ports.

Run `npm run test:e2e -- test/e2e/room-entry.spec.ts` for focused entry checks through the production `/rooms`, `/rooms/join`, and `/games/:gameId` routes, using the shared room helpers and the same real room/auth services and disposable PostgreSQL. The suite covers invitation sharing/replacement/revocation, fragment and history cleanup, account/guest admission, token-free authentication returns, lost create/join acknowledgement recovery, clipboard fallback, keyboard use, and accessibility. Waiting, joined, and terminal assertions exercise the room controller and WebSocket synchronization.

Run `npm run test:e2e -- test/e2e/room-http.spec.ts` for two independent browser identities completing and closing rooms through the real cookie-authenticated HTTP API on desktop/mobile. It verifies creation/join retries and the existing private history presentation without introducing room gameplay screens. PostgreSQL admission, concurrency, retention and command checks live in `rooms.integration.test.ts`, `room-admission-races.integration.test.ts` and `room-commands.integration.test.ts` alongside the predecessor room suites.

The isolated browser-test server also serves `/__test__/setup`, mounting the Arena setup adapter with injected discovery fixtures and the real guest/game API and disposable database. This isolated entry stops at a creation/return handoff; the public `/` entry exercises the complete match controller using the same test-only provider fixtures. Run `npm run test:e2e -- test/e2e/ai-setup.spec.ts` for setup behavior and layout checks. For interactive review, run `node --conditions=development --import tsx test/e2e/server.ts` and open `https://localhost:5174/__test__/setup`; use non-secret placeholder keys only. `rejected-fixture` and `empty-fixture` exercise discovery error/empty states. Stop this server before running Playwright, which owns the same ports. This test entry and all provider fixtures are absent from normal Vite servers and production bundles.

On that disposable test server, `/` plays Fool's Mate with ordinary placeholder keys. `slow-fixture` delays inference, `quota-fixture` produces a provider pause, and `invalid-fixture` exhausts the three-invalid-output budget. These injected fixtures never call an external provider. Run `npm run test:e2e -- test/e2e/ai-match.spec.ts` for public controls, controller loss, competing tabs, uncertain acknowledgements, refresh/key recovery, private replay, and responsive layout.

The competing-tab/between-call absence and heartbeat-loss scenarios carry `@controller-protocol` and run in all three desktop engines; both mobile projects exclude that tag at collection. Run just those scenarios with `npm run test:e2e -- --project=firefox-desktop --grep=@controller-protocol`. Other match recovery, focus, and interaction scenarios run in all five projects.

Run `npm run test:e2e -- test/e2e/ai-human.spec.ts` for either human color, AI-first play, promotion, duplicate/uncertain human commands, provider retry, single-key recovery, resignation, and natural completion. `promotion-fixture` supplies a legal promotion approach from the standard position in this isolated server only.

Run `npm run test:e2e -- test/e2e/ai-telemetry.spec.ts` for replay-linked commentary/usage, retry Events, incomplete operational totals, and detail-read recovery. `telemetry-fixture` supplies two initial invalid outputs followed by legal moves, literal markup commentary, and mixed reported/missing usage. `retry-fixture` supplies an invalid output followed by a quota pause; replacing it with an ordinary placeholder key permits explicit retry. These are test-server fixtures only. The provider matrix in `apps/api/test/provider-matrix.integration.test.ts` instead exercises all four real adapters through injected HTTP responses, the API, and PostgreSQL. Neither suite establishes current live-provider availability.

The same telemetry suite uses `cost-fixture` with identical OpenAI `gpt-4.1-mini-2025-04-14` seats, reported billing dimensions, two initial invalid responses and a zero-cost accepted call to verify stored estimates across live play, replay, Events and seat/game totals. `cost-partial-fixture` omits a required billing counter and reports an unknown service tier; `cost-invalid-fixture` reaches technical loss without an accepted move. These injected adapters exercise real API costing and persistence without paid provider calls. Unit/component/feed tests under `apps/web/src/match` additionally cover exact large/tiny amounts, historical gaps, same-revision discarded outcomes and identity cancellation.

### Browser installation

After installing dependencies, prepare all three engines and the disposable database:

```text
npm exec playwright -- install chromium firefox webkit
npm run infra:test:up
npm run verify
npm run test:e2e
```

The acceptance and performance harnesses use HTTPS/WSS with the public, test-only
localhost certificate/key under `test/e2e/certificates`. Playwright uses
`ignoreHTTPSErrors` only for this self-signed fixture; the lifecycle integration worker
adds that certificate to its own Node trust list and restores it afterwards. Nothing
is installed into the OS trust store. This preserves the real Secure/HttpOnly cookie
policy across engines, including WebKit, without asserting production certificate trust.
Never deploy these fixture keys. To replace an expired fixture, generate a new
self-signed localhost certificate with DNS `localhost` and loopback IP SANs and rerun
the entire matrix and lifecycle integration tests.

### Windows browser server

The required automated matrix runs on Ubuntu 24.04. The pinned Windows WebKit port
skips links during native Tab/Option-Tab traversal and exposes no `tabsToLinks`
setting; it cannot establish the complete keyboard journey. On Windows, use the
matching Linux browser server while keeping tests, services and output in the current
checkout. In a separate terminal, start:

```text
docker run --rm --init --ipc=host --name neurochess-playwright -p 127.0.0.1:39099:3000 -w /home/pwuser mcr.microsoft.com/playwright:v1.64.1-noble npx -y playwright@1.64.1 run-server --port 3000 --host 0.0.0.0 --unsafe
```

Then run from PowerShell:

```powershell
$env:PW_TEST_CONNECT_WS_ENDPOINT = 'ws://127.0.0.1:39099/'
$env:PW_TEST_CONNECT_EXPOSE_NETWORK = '<loopback>'
npm run test:e2e
Remove-Item Env:PW_TEST_CONNECT_WS_ENDPOINT
Remove-Item Env:PW_TEST_CONNECT_EXPOSE_NETWORK
```

Stop the temporary server with `docker stop neurochess-playwright`. Keep its published
port bound to loopback and use the same pinned Playwright version on both ends. The
`--unsafe` flag lets trusted local tests pass their browser launch options: without it,
the server discards `ignoreDefaultArgs`, leaving Chromium's native scrollbars hidden
and invalidating the model-list drag regression. Use this flag only for this disposable,
loopback-only server with trusted test clients; do not expose it to a shared network or
mount host credentials or the Docker socket into its container. The
loopback tunnel preserves localhost HTTPS origins and Secure cookie behavior. Downloads
are read through streams so assertions also work with a remote browser. This uses
[Playwright's supported remote-server workflow](https://playwright.dev/docs/docker#remote-connection).
Real Safari keyboard preferences and OS behavior remain part of the physical release matrix.

### Test server and artifacts

Playwright global setup forks the actual Fastify guest/game services and Vite app at `https://localhost:3101` and `https://localhost:5174`, plus a Sandbox-disabled web app at `https://localhost:5175`, and waits for IPC readiness. These ports must be free; the suite refuses to reuse existing servers. The test entrypoint validates `TEST_DATABASE_URL` with the same `_test`/no-options guard as integration tests before opening a connection or applying reviewed migrations. It never falls back to `DATABASE_URL`. Games use the real API and legal moves from the standard position. Transport-fault cases replace acknowledgements before or after execution; authoritative reads and explicit retries still use the real service.

All five engine/device projects create a game, play part of Fool's Mate, refresh into paused recovery, explicitly resume, complete checkmate, navigate every replay position, copy/download PGN, start another game, and reopen the previous private URL. Downloaded text must exactly equal persisted PGN. Every engine must complete a native clipboard write with the canonical text; Chromium and WebKit also read it back, normalizing Windows CRLF conversion. Firefox does not expose the clipboard-read permission grant, so its check observes the text only after the native write succeeds. Denied invitation copying still verifies the selectable fallback. Further cases cover both resignation colors, neutral abortion, isolated-guest access denial, Sandbox-entry recovery, private game URLs, enabled/disabled navigation, and White knight/Black rook underpromotions through legal moves from the standard position.

Accessibility and layout checks cover keyboard directions, castling, en passant and Tab order, modal focus containment/return, readable control labels, 44px controls, reduced motion, stable move-history placement during commands, and axe checks. Entry, live, recovery, and replay use legal sample positions at 320/390/768/1024/1440px, also with 200% text and 50% expanded test resources; promotion choices remain reachable with enlarged text at every width. Expansion is injected by the test into the dev module; it is not a product locale or flag. Uncertain move, pause, and recovery commands verify locked controls and identical explicit retries; committed and conflicting moves verify complete snapshot adoption without duplicate submission.

In `arena-states.spec.ts`, entry/live/recovery geometry runs at 1024/1440px in each desktop project and 320/390/768/1024px in each mobile project, with both text sizes in each assigned width. The shared 1024px boundary retains coverage with both device settings. State transitions, focus, touch, and axe checks still run at each project's default viewport. Replay and `ai-setup.spec.ts` retain the full width/text matrix in all projects because native scrollbar gutters change their geometry. The separate telemetry and move-history specs retain their additional layout boundaries, including 1025px.

Use the `newContext` fixture for additional browser contexts, which inherits the selected project device settings; pass overrides only when intentional. Do not infer touch or mobile behavior from project names. It installs the same observers as the default context, assigns a unique `neurochess_test_client` cookie for independent authentication rate limits, and closes extra contexts at teardown. Every page in each context is monitored for console warnings/errors, window errors, unhandled rejections and unexpected HTTP responses. HTTP checks use response events because Firefox omits Chromium-style resource console messages. WebKit can report navigation-canceled fetches as native WebErrors; actual uncaught JavaScript is observed through window error/rejection events instead. Chromium additionally keeps WebErrors because its unhandled worker rejections reach neither window listeners nor the console; Firefox and WebKit log them to the console. Expected game 404s and allowed identity 401s are scoped by page and exact URL; preserve the test-client cookie when copying or clearing application cookies. `context-fixtures.spec.ts` verifies isolation and uses expected teardown failures to prove secondary-page errors reach the owning test.

Only the exact WASM-cancellation diagnostics from an obsolete Stockfish worker after
navigation are allowed, and that worker must close by teardown. A live worker's load
failure remains fatal, covered by a deliberately rejected real-engine load in the
fixture tests. Browser console payloads are never forwarded into server logs.

Each browser context has an isolated guest. Per-test cleanup deletes guests/games associated with captured game creations across all instrumented contexts and pages. The server tracks every guest it creates, including guests without games and additional browser contexts. Global teardown sends an IPC shutdown command and requires both cleanup acknowledgement and a zero process exit, including after failed tests. Cleanup attempts every server, scoped database deletion, and pool closure even if an earlier step fails. A shutdown timeout forces termination and fails the run; successful cleanup never depends on Windows signal support. Manual server runs retain `SIGINT`/`SIGTERM` shutdown handlers. `npm test` also checks this lifecycle against real child processes and the disposable database, so ports 3101, 5174, and 5175 must be free for integration tests too.

Screenshots and failure context default to `neurochess-playwright-results` in the OS temporary directory, outside the repository. For task-specific runs, pass `--output=<absolute temporary directory>/playwright` after `npm run test:e2e --` and redirect logs there. Retain evidence externally only when needed to continue across sessions; remove temporary output when finished. Traces, HARs, and videos are disabled so authentication and guest cookie headers are not recorded.

The duration reporter writes `durations.json` in the same output directory. It records the run status/start/duration and each attempt's project, source location, static test title, repeat/retry index, status and duration in milliseconds. Its field allowlist excludes errors, console output, steps, attachments and configuration metadata. Keep credentials and runtime values out of test titles. Collection-only runs do not replace duration evidence.

### CI workflows and evidence

CI runs on pull requests and pushes to `master`. The `checks` job runs Compose and migration checks, `npm run verify`, and the built-service startup check `npm run smoke`. In parallel, the `e2e` matrix splits `chromium-desktop` and `chromium-mobile` into two shards each, while the independent `performance` matrix runs each project once without sharding. The `deployment` matrix builds and rehearses production containers on AMD64 and ARM64, including Chromium/Firefox/WebKit checks through Caddy. The final `verify` check runs even when a dependency fails, is cancelled, or is skipped, and passes only when `checks`, the entire E2E matrix, the entire performance matrix and both deployment jobs succeed.

The separate Cross-browser E2E workflow runs `firefox-desktop` in three shards and both WebKit projects in four. To keep their runner minutes off ordinary changes, it runs weekly, on manual dispatch, and on pull requests that change `package-lock.json`, `playwright.config.ts` or either browser workflow, so dependency and Playwright updates exercise every engine on the pull request. Other Firefox/WebKit regressions can surface up to a week later; dispatch it for changes to focus, scrolling, clipboard, cookies, sockets or workers, and before a release. The run is advisory: it reports separately from `verify` and does not block merging, so check its result before merging a dependency or Playwright update.

Both workflows share the job definition in `.github/workflows/browser-e2e.yml`. Each browser job has its own runner, PostgreSQL service, shared-package build, matching engine installation, and one Playwright worker. Shard counts leave setup headroom against measured test durations; review the duration artifacts as the suite grows. All jobs retain a 15-minute timeout.

To reproduce an E2E shard, run `npm run test:e2e -- --project=firefox-desktop --shard=1/3 --workers=1`, substituting the project and shard as needed. Keep local shard, performance, and integration runs sequential because they share the test server ports.

Each E2E matrix job uses its own runner-temporary output directory including the project and shard. Completed browser runs upload `e2e-durations-<project>-shard-<shard>`; failed runs also upload `e2e-failures-<project>-shard-<shard>` with only failure PNGs and the duration report. Performance jobs retain `performance-<project>` with `measurements.json`, `long-replay.json`, `wasm-memory.json`, and `lifetimes.json`. All artifacts expire after seven days. Raw logs, failure-context files, downloads and authentication state are excluded from uploads.

Automated checks do not certify screen-reader behavior, physical devices or branded Safari/Edge installations. Consult the [current validation limits](../design-system.md#validation-limits) for remaining coverage gaps. Report each run in the change summary, PR, or CI; update that section only when a gap changes.

### Account lifecycle acceptance

The [Phase 3 milestone](../roadmap.md#phase-3--accounts-encrypted-credentials-and-history) uses the coverage below. Integration files are under `apps/api/test` unless otherwise noted; browser files are under `test/e2e` and run in all five E2E projects.

For authenticated test preconditions, `createAccount(request)` in `test/e2e/account-helpers.ts` creates a unique verified account, signs in the supplied request context, and completes username onboarding. It returns the email, password, and username for subsequent browser actions. Keep registration, password recovery, and cross-tab onboarding acceptance journeys in the browser; account-race tests use API setup and retain the browser sign-in/sign-out and discovery actions that create each race.

| Contract                                                                                                               | Integration coverage                                                                                                                                                       | Browser coverage                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Verified registration, resend, password reset, session invalidation and safe callbacks                                 | `email-auth.integration.test.ts`, `auth-password-race.integration.test.ts`, `auth.integration.test.ts`                                                                     | `accounts.spec.ts`                                                                                                               |
| Google/GitHub admission, callback state, disabled linking and provider-token removal                                   | `oauth-auth.integration.test.ts`                                                                                                                                           | Google/GitHub fixtures in `accounts.spec.ts`                                                                                     |
| Username uniqueness, common onboarding and safe removable avatars                                                      | `profiles.integration.test.ts`, `packages/database/test/profiles.integration.test.ts`                                                                                      | `accounts.spec.ts`                                                                                                               |
| Both account AI modes, simultaneous sessions, one public game, paused recovery, sign-out/expiry and private completion | `account-games.integration.test.ts`, `account-recovery.integration.test.ts`, `account-session-fences.integration.test.ts`                                                  | `account-acceptance.spec.ts`, `accounts.spec.ts`, `credentials.spec.ts`                                                          |
| Encrypted opt-in saving, independent seat sources, revocation, unavailable keys and secret redaction                   | `credentials.integration.test.ts`, `saved-credential-operations.integration.test.ts`                                                                                       | `credentials.spec.ts`, `account-acceptance.spec.ts`; storage/URL checks in `credential-privacy.ts`                               |
| Private completed/aborted history, replay and canonical PGN                                                            | `history.integration.test.ts`                                                                                                                                              | `history.spec.ts`, `account-acceptance.spec.ts`                                                                                  |
| Scoped game/history deletion and atomic account deletion during in-flight work                                         | `history-deletion.integration.test.ts`, `history-deletion-races.integration.test.ts`, `account-deletion.integration.test.ts`, `account-deletion-races.integration.test.ts` | `history.spec.ts`, `account-deletion.spec.ts`                                                                                    |
| Guest restrictions and separation, guest AI modes and independent enabled/disabled Sandbox                             | `account-games.integration.test.ts`, `identity.integration.test.ts`, `ai-human.integration.test.ts`, `games.integration.test.ts`                                           | `accounts.spec.ts`, `ai-match.spec.ts`, `ai-human.spec.ts`, `sandbox-isolation.spec.ts`, `navigation.spec.ts`, `sandbox.spec.ts` |
| Fresh/repeated migrations and preservation of populated prior schemas                                                  | `test/integration-setup.ts`, [database migration suites](../../packages/database/test), `historical-upgrade.integration.test.ts`                                           | Real migrated PostgreSQL backs every browser test                                                                                |

The cross-device acceptance cases sign in through independent browser contexts, expire only the originating database session, and complete each AI mode using explicit credential recovery on the surviving device. The original device must sign in again to open private history and download matching PGN. The browser expiry check permits a credential-list `401` only while its focus refresh races identity clearing; unrelated console errors still fail.

### Fresh-install and migration acceptance

For a fresh-install check, run `npm ci`, provision a new empty database in the disposable PostgreSQL test service, and point both `TEST_DATABASE_URL` and the migration command's `DATABASE_URL` at that database. Verify it is empty before running `npm run db:migrate` twice, then run `npm run db:check`, `npm run verify`, `npm run test:e2e` and `npm run smoke`. Do not repoint or reset a development/shared database. The `packages/database/test/historical-upgrade.integration.test.ts` scenario separately applies the committed SQL in an isolated schema, verifies retained rows and encrypted credentials through migration `0018`, and removes its own schema. Do not run integration and browser suites concurrently: both exercise the browser-server lifecycle on ports 3101, 5174 and 5175. See [CI workflows](#ci-workflows-and-evidence) for the checks split across independent runners.

All default acceptance tests use real application/auth/database services with injected email, OAuth and inference transports; SMTP protocol tests use a loopback mailbox. They do not verify live consent screens, external inbox delivery, live provider availability or production infrastructure. Before deployment, configure and manually verify Google/GitHub clients and callback URLs, SMTP sender/TLS/deliverability, same-site HTTPS origins and proxy trust, stable auth/encryption secrets, and separate encryption-key backup/recovery. Follow the selected [hosting and rollout procedure](../operations.md); activate the [monitoring](../operations.md#operational-monitoring) and [backup/recovery](../recovery.md) procedures, including independent secret recovery and actual notification delivery. Credential rotation follows the [offline maintenance runbook](../credential-rotation.md); automatic purging of expired solo guest records remains a separate product decision. Physical-browser and operational release gates remain tracked in the [roadmap](../roadmap.md).
