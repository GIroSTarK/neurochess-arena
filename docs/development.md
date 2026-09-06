# Development guide

## Local setup

Use Node.js 24 and npm 11. From a clean clone:

```text
npm ci
```

Build, watch, and type-check commands use the native TypeScript 7 compiler through the `@typescript/native` npm alias, which provides `tsc`. Keep `typescript` aliased to `@typescript/typescript6` so ESLint and dependency-cruiser can use the TypeScript 6 compiler API. Retain both aliases when updating the toolchain; see the [upstream compatibility guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0).

Copy `.env.example` to `.env`. The committed values are local placeholders only; never place production credentials in the repository.

Start PostgreSQL and wait for its health check:

```text
npm run infra:up
```

Apply the reviewed migration history, then start the TypeScript package watchers, Fastify API, and Vite app:

```text
npm run db:migrate
npm run dev
```

The API reads the root `.env` file when present. Vite also uses the root as its environment directory but exposes only variables prefixed with `VITE_`.

## Environment contract

| Variable                    | Consumer   | Purpose                                                                   |
| --------------------------- | ---------- | ------------------------------------------------------------------------- |
| `NODE_ENV`                  | API        | `development`, `test`, or `production`                                    |
| `API_HOST`                  | API        | Fastify listen address                                                    |
| `API_PORT`                  | API        | Fastify listen port                                                       |
| `WEB_ORIGIN`                | API        | Exact browser origin allowed by CORS                                      |
| `DATABASE_URL`              | API, tools | PostgreSQL connection URL                                                 |
| `LOG_LEVEL`                 | API        | Pino log level                                                            |
| `SANDBOX_ENABLED`           | API        | Exactly `true` or `false`; defaults to false; production rejects true     |
| `GUEST_SESSION_TTL_SECONDS` | API        | Inactivity expiry, 1–31536000 seconds; defaults to 86400                  |
| `VITE_API_BASE_URL`         | web        | Public HTTP(S) API origin, without credentials, paths, query, or fragment |
| `POSTGRES_*`                | Compose    | Local database name, user, password, and port                             |
| `TEST_DATABASE_URL`         | Tests      | Explicit disposable PostgreSQL database ending in `_test`; no fallback    |
| `TEST_POSTGRES_PORT`        | Compose    | Separate test-service port, defaults to 5433                              |

Invalid environment errors contain variable names only. Never add server secrets to a `VITE_` variable.

## Root commands

| Command                      | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `npm run dev`                | Build shared packages, watch them, and run both applications     |
| `npm run build`              | Build shared packages, the API, and the Vite production bundle   |
| `npm start`                  | Run the built API and web preview                                |
| `npm run lint`               | Run ESLint with zero warnings                                    |
| `npm run typecheck`          | Type-check project references and tests                          |
| `npm test`                   | Run unit, PostgreSQL integration, and dependency-boundary checks |
| `npm run test:unit`          | Run database-free unit tests                                     |
| `npm run test:integration`   | Run required PostgreSQL-backed tests; fail if unavailable        |
| `npm run test:e2e`           | Run desktop/mobile browser gameplay and accessibility checks     |
| `npm run format:check`       | Verify Prettier formatting                                       |
| `npm run verify`             | Run formatting, lint, types, tests, and build                    |
| `npm run smoke`              | Start and probe both built services                              |
| `npm run infra:up`           | Start and health-check PostgreSQL                                |
| `npm run infra:test:up`      | Start the isolated disposable test PostgreSQL service            |
| `npm run infra:down`         | Stop PostgreSQL while preserving data                            |
| `npm run db:generate -- ...` | Generate a named Drizzle migration                               |
| `npm run db:check`           | Check migration metadata for consistency                         |
| `npm run db:migrate`         | Apply pending migrations                                         |
| `npm run db:studio`          | Open Drizzle Studio                                              |

## Dependency direction

- `apps/web` may consume `packages/contracts` and presentation-safe exports from `packages/chess`.
- `apps/api` may consume `packages/contracts`, `packages/chess`, and `packages/database`.
- `packages/contracts` and `packages/chess` are infrastructure-independent leaves.
- `packages/database` is server-only and does not depend on application code.
- Product packages expose explicit entrypoints; consumers must not deep-import their source files.

`npm run test:architecture` validates the real graph, including external dependency edges without traversing dependency implementations. Deliberately invalid fixtures prove the web/database boundary, both independent leaves, rules-engine encapsulation, public entrypoints, the shared-package infrastructure restrictions, and exclusion of chess test helpers from production imports.

## Chess domain development

The [domain and core contract boundary](architecture.md#deterministic-domain-and-core-contracts) remains independent of HTTP and persistence. The API now consumes it through the guest command service. Import only package entrypoints. `createGame()` starts in `configuring`; call `start()` before submitting canonical UCI. Snapshot and command results contain copied data. `restoreGame({ moves, lifecycle })` replays ordered UCI moves and validates the supplied lifecycle instead of accepting a cached FEN or PGN.

Focused checks require neither PostgreSQL nor provider credentials:

```text
npm exec vitest -- run packages/chess/test packages/contracts apps/api/src/game-contracts.test.ts
npm run test:architecture
```

Special-position fixtures live in `packages/chess/test`, outside the production TypeScript root and package exports. They exercise the internal adapter through the same aggregate used by public factories. Do not export a FEN constructor, import fixtures into production, or replace the normalized repetition key with the engine's built-in hash. The regression tests cover pinned en passant, restoration between repetition cycles, and the 99-to-100 half-move boundary.

## Provider contract tests

Run the shared AI schemas, canonical context, parameter resolution, and scripted provider checks without network access or provider credentials:

```text
npm exec vitest -- run packages/contracts/src/ai.test.ts apps/api/src/providers
```

Use `createScriptedMockProvider` from `apps/api/src/providers/mock.ts` in server tests. Supply a provider descriptor, fixture model descriptors, and ordered move steps containing either `output` (structured data or JSON text, including malformed fixtures) or a classified provider `error`. Optional telemetry supplies deterministic latency and reported usage; omitted telemetry means simulated zero latency and unavailable usage. `discoveryError` scripts a model-list failure. The mock consumes one step per valid request and throws `MOCK_SCRIPT_EXHAUSTED` when the script runs out, so unintended extra attempts fail tests.

Request captures contain defensive copies of effective configuration, canonical context, and the common response instruction; they omit API keys and abort signals. Use placeholder credentials only. The mock does not perform retries or game commands. Integration tests inject it into the real [guest AI service](#guest-ai-game-api); the normal server registers no mock or real provider. See the [provider boundary](architecture.md#ai-provider-boundary) for validation, failure classification, and caller responsibilities.

## Sandbox UI

Set `SANDBOX_ENABLED=true` in the local `.env`, apply migrations, and run `npm run dev`. Open `http://localhost:5173` and choose **Start sandbox**. The service readiness indicator checks the database through `/ready`; sandbox availability is determined by creation, so a healthy server can still report that its sandbox is disabled. Enable it on the development server and choose **Retry sandbox**.

One guest controls White and Black. Select a source and a highlighted destination, or use the [board keyboard controls](design-system.md#keyboard-and-chess-interaction). Promotion always requires an explicit piece choice. Flip board changes presentation only. Pieces, turn, result, and SAN history stay unchanged until an authoritative response arrives.

An uncertain submission keeps the original move or lifecycle command in memory. **Check game status** reads the authorized snapshot; **Retry same move** or **Retry same command** reuses the original ID, version, and payload. A same-version GET is still uncertain because the first request could commit later. Rejections also require synchronization before another command. Access loss clears the board, replay, and export text and requires **Start sandbox again**.

Creation updates the private URL to `/?game=<uuid>`. Refresh, reopening that URL, or opening the root page with an existing guest discovers the game without bootstrapping a new guest. Recovery pauses an active game through a versioned command before enabling controls; an already-paused game requires no write. Choose **Resume** explicitly to continue. Concurrent active snapshots are reconciled with at most three pause attempts before **Retry recovery** is offered. An uncertain pause follows the same command retry flow as a move.

**Pause** and **Resume** preserve the position and history. **Abort**, **Resign White**, and **Resign Black** are available while active or paused. The confirmation dialog initially focuses Cancel and explains the outcome. Abortion displays **Game stopped**, keeps result `*`, and releases the unfinished-game slot. Resignation awards the other color the win, including when the resigning color is off-turn.

Completed and aborted games show their result and termination reason, open replay at the final ply, and offer **First**, **Previous**, **Next**, **Last**, and selectable SAN moves. Replay changes only the displayed position. **Copy PGN** and **Download PGN** fetch the private, authorized export endpoint; clipboard failure reveals selectable text. A download contains the canonical UTF-8 text in `neurochess-<uuid>.pgn`. **New game** preserves the previous record and private URL; browser Back can reopen it. Access remains limited to the owning guest until the existing inactivity expiry (24 hours by default). This development flow exposes no recent-games list and performs no retention cleanup.

Visible copy and document metadata come from `apps/web/src/i18n/en.ts`. Use complete messages and named placeholders; keep UCI, SAN, and coordinates unchanged. The i18next resource declaration type-checks keys, falls back to English, and ships no browser-language detection. Inter and Orbitron are bundled locally. API error codes map to catalog entries; do not display server messages or caught exceptions.

Presentation uses Tailwind CSS utilities in JSX. The [design-system tokens](design-system.md#foundations), base layer, and the few custom utilities live in `apps/web/src/styles.css`; shared controls sit under `apps/web/src/ui`. Prettier sorts class names, so run `npm run format` after editing markup. Tests select elements by role, accessible name, or data attribute rather than by class.

## Sandbox API

Set `NODE_ENV=development` and `SANDBOX_ENABLED=true` in the local `.env`, apply migrations, and start the API. Production configuration rejects enablement; disabled servers also reject access to already-persisted sandbox games. The [web sandbox](#sandbox-ui) uses these endpoints unchanged.

| Endpoint                        | Request                                                        | Success                                            |
| ------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `POST /guest-session`           | `{}`                                                           | `200 { "status": "ready" }` plus guest cookie      |
| `POST /sandbox/games`           | `{}`                                                           | `201` standard-position active snapshot, version 0 |
| `GET /sandbox/games/unfinished` | No query fields                                                | `200 { snapshot }`, unfinished game or `null`      |
| `GET /games/:gameId`            | UUID parameter, no query fields                                | `200` current authorized snapshot                  |
| `POST /games/:gameId/moves`     | `{ gameId, move, expectedVersion, commandId }`                 | `200` accepted snapshot                            |
| `POST /games/:gameId/lifecycle` | `{ gameId, action, expectedVersion, commandId, losingColor? }` | `200` accepted snapshot                            |
| `GET /games/:gameId/replay`     | UUID parameter, no query fields                                | `200 { snapshot, initialFen }`, terminal only      |
| `GET /games/:gameId/pgn`        | UUID parameter, no query fields                                | `200 { gameId, version, pgn }`, terminal only      |

Lifecycle actions are `pause`, `resume`, `abort`, and `resign`. Only resignation accepts and requires `losingColor` (`white` or `black`). Control commands require ownership; resignation requires authority over the chosen human seat. Only the enabled development sandbox grants its owner authority over both human seats. Discovery never creates a guest; a `401` discovery response tells the browser to show the entry screen. All reads preserve lifecycle and verify complete persisted history and projections.

Bootstrap once and await the cookie before issuing game requests; clients must coordinate first-use bootstrap instead of racing cookie-less initializations. Missing, invalid, or expired cookies on game requests return `401`, with no implicit replacement. Bootstrap alone can replace an expired session; replacement never recovers that session's old games.

Browser requests use `credentials: "include"`. All POSTs require JSON and an `Origin` header exactly equal to `WEB_ORIGIN`, including command-line clients. Use `localhost` consistently for the web and API origins during HTTP development: supported browsers allow Secure cookies on localhost. Non-localhost access requires HTTPS; there is no insecure-cookie override. A cookie jar contains a bearer credential: do not print, commit, or share its contents.

PowerShell example (with `curl.exe`; retain the temporary jar only while continuing this CLI session):

```powershell
$guestCookieJar = Join-Path ([IO.Path]::GetTempPath()) ("neurochess-" + [guid]::NewGuid() + ".cookies")
$headers = @("-H", "Origin: http://localhost:5173", "-H", "Content-Type: application/json")
curl.exe -sS -c $guestCookieJar @headers --data "{}" http://localhost:3001/guest-session | Out-Null
$game = curl.exe -sS -b $guestCookieJar -c $guestCookieJar @headers --data "{}" http://localhost:3001/sandbox/games | ConvertFrom-Json
$move = @{ gameId = $game.gameId; move = "e2e4"; expectedVersion = $game.version; commandId = [guid]::NewGuid().ToString() } | ConvertTo-Json -Compress
$move | curl.exe -sS -b $guestCookieJar -c $guestCookieJar @headers --data-binary "@-" "http://localhost:3001/games/$($game.gameId)/moves"
curl.exe -sS -b $guestCookieJar -c $guestCookieJar "http://localhost:3001/games/$($game.gameId)"
# When finished with this CLI identity:
Remove-Item -LiteralPath $guestCookieJar
```

Use a new command UUID for each move or lifecycle action and reuse the identical command for retries. The body game ID must match the path. After read authorization, stale/future versions and duplicate accepted IDs (including changed payloads or command kinds) return `409 GAME_CONFLICT` with `currentSnapshot`. An occupied active/paused slot returns the same authorized conflict envelope. Refresh client state from that snapshot; never automatically apply a stale move or user action to a new version. Versions advance once per accepted command, including the terminal command; lifecycle commands add no move. A duplicate terminal command still returns a conflict snapshot; a fresh terminal or paused move returns `409 INVALID_GAME_STATE`. Illegal moves return `422`; malformed requests return `400`.

Requests cannot select FEN, history, owner, seat, public mode, or sandbox authority; unknown body/query fields are rejected. Missing or expired sessions receive `401`; inaccessible games receive `404` without snapshots. Replay and export reject unfinished games with `409 INVALID_GAME_STATE`. Completed and aborted records remain private and readable until guest access expires. Pausing occurs only through an authorized POST, never as a side effect of a read.

## Guest AI game API

These routes reuse [guest bootstrap, cookies, Origin checks, private reads, and command semantics](#sandbox-api), without requiring sandbox enablement:

| Endpoint                      | Request                                  | Success                                                |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `POST /ai/games`              | AI configuration described below         | `201` standard-position active snapshot, version 0     |
| `GET /ai/games/unfinished`    | No query fields                          | `200 { snapshot }`, owned unfinished AI game or `null` |
| `POST /games/:gameId/ai-turn` | `{ gameId, expectedVersion, commandId }` | `200` snapshot after one active turn or paused step    |

Creation accepts exactly one of:

```json
{
  "mode": "ai_vs_ai",
  "white": { "provider": "openai", "modelId": "fixture-model", "parameters": { "temperature": 0 } },
  "black": { "provider": "openai", "modelId": "fixture-model", "parameters": { "temperature": 1 } }
}
```

```json
{
  "mode": "ai_vs_human",
  "humanColor": "black",
  "ai": { "provider": "openai", "modelId": "fixture-model", "parameters": {} }
}
```

`fixture-model` is a test fixture, not a production model. `createGameService` accepts an optional `ai` composition containing adapters and trusted model descriptors. Tests supply `createScriptedMockProvider` and fixture descriptors; creation resolves supported parameters before persistence. The normal server supplies no adapters, so creation or a fresh AI turn requiring an unavailable adapter returns `404 NOT_FOUND`. Production adapters, live discovery, request-scoped key transport, and AI browser flows are separate roadmap work. These requests reject credentials, capabilities, FEN, prompts, seat/owner identities, execution IDs, and lease settings supplied by clients.

Both AI modes and the sandbox share the single active/paused slot. AI-versus-human assigns only the chosen human seat to the guest; ownership cannot move or resign an AI seat. Existing snapshot, lifecycle, terminal replay, and PGN routes retain their private authorization. AI discovery excludes sandbox/human-room games and never changes lifecycle, allocates a guest, or calls an adapter. Recovery requires the ordinary authorized pause command, then an explicit step or resume.

The same AI-turn body requests **Next move** from a paused game. It is allowed only on an AI seat's turn and leaves an unfinished game paused, including while waiting for the provider. A terminal move or technical loss completes the game. **Pause**, **Resume**, and **Stop** use the existing lifecycle route with actions `pause`, `resume`, and `abort`; Stop records `aborted` with result `*`. Resume changes lifecycle without calling a provider. Pause on an already-paused AI game is accepted only when it has an outstanding reservation to cancel or abandon, advancing the revision once; otherwise it returns `INVALID_GAME_STATE`.

The server derives the current AI seat and full chess context from verified history. It reserves the command and records a pending invocation in a short transaction before calling the adapter outside that transaction. A live request renews its server-controlled lease. Finalization rechecks access, position, execution ownership, and lease; it validates the move through the deterministic aggregate and atomically records the outcome, move, shared receipt, and new revision. One request executes one turn, including at most two model-invalid retries; it never starts the next side's turn. A third invalid response commits a technical loss. A classified provider failure commits a pause without an automatic retry. For **Retry**, submit a fresh command ID and the paused snapshot's version to `ai-turn`, or explicitly resume before requesting a fresh active turn. Provider failures, interruptions, and lifecycle changes preserve the current turn's recorded invalid-output count; only an accepted move resets it. Retrying an old ID remains a conflict and never calls the provider again. Invocation telemetry remains internal; the response uses the existing snapshot schema.

Duplicate IDs, competing requests, stale revisions, expired reservations, and late results return `409 GAME_CONFLICT` with an authorized current snapshot. A same-version conflict does not prove the original request finished. No duplicate may repeat the adapter call. Pause, resume, abort, or human resignation can invalidate a pending turn without waiting for the adapter. An HTTP disconnect stops lease renewal and signals cancellation; an uncertain reservation requires explicit Pause (even when already paused) and a new command, never automatic takeover. The user may then step or resume. Unexpected adapter failures return a fixed safe `500` and require the same recovery; no raw provider object is logged or returned.

Focused verification uses the actual service and disposable PostgreSQL database with mocks only:

```text
npm exec vitest -- run --config vitest.integration.config.ts apps/api/test/ai-games.integration.test.ts apps/api/test/ai-lifecycle.integration.test.ts
```

## PostgreSQL integration tests

Add `TEST_DATABASE_URL` from `.env.example` if updating an existing `.env`, then run:

```text
npm run infra:test:up
npm run test:integration
npm run verify
```

The test service binds loopback port 5433 and uses tmpfs instead of the development volume. Its data is disposable when the container stops. Tests require an explicit PostgreSQL URL whose database name ends in `_test` and reject connection-level `options`; they never fall back to `DATABASE_URL`. Global setup applies reviewed migrations twice. Fixtures use unique guest IDs and cleanup deletes only those guests' games and sessions, not whole tables. Concurrent scenarios use independent pools/API instances, and rollback tests fail after an actual SQL insert. Tests never silently skip when PostgreSQL is unavailable.

CI uses its own ephemeral `neurochess_test` database and runs integration tests through `npm test`. Unit tests and architecture checks remain runnable without PostgreSQL. Keep `TEST_DATABASE_URL` pointed only at a dedicated disposable database, never shared or production data.

## Browser tests

After installing dependencies, prepare Chromium and the disposable database:

```text
npm exec playwright -- install chromium
npm run infra:test:up
npm run verify
npm run test:e2e
```

Playwright starts the actual Fastify guest/game services and Vite app at `http://localhost:3101` and `http://localhost:5174`. These ports must be free; the suite refuses to reuse existing servers. The test entrypoint validates `TEST_DATABASE_URL` with the same `_test`/no-options guard as integration tests before opening a connection or applying reviewed migrations. It never falls back to `DATABASE_URL`. No arbitrary-position endpoint or mocked gameplay API is used.

Desktop Chromium and a Chromium mobile-touch context create a game, play part of Fool's Mate, refresh into paused recovery, explicitly resume, complete checkmate, navigate every replay position, copy/download PGN, start another game, and reopen the previous private URL. Downloaded text must exactly equal persisted PGN; clipboard readback normalizes Windows CRLF conversion while the client writes the canonical text unchanged. Further cases cover both resignation colors, neutral abortion, isolated-guest access denial, root-page recovery, and White knight/Black rook underpromotions through legal moves from the standard position.

Accessibility and layout checks cover keyboard directions and Tab order, modal focus containment/return, 44px controls, reduced motion, 320/390/768/1024/1440px layouts, 200% text, 50% expanded test resources, stable move-history placement during commands, and axe checks. Expansion is injected by the test into the dev module; it is not a product locale or flag.

Each browser context has an isolated guest. Cleanup deletes only guests/games created by that test; the server also tracks guests it created for graceful shutdown. Screenshots and failure context go to `neurochess-playwright-results` in the OS temporary directory, outside the repository. Traces, HARs, and videos are disabled so guest cookie headers are not recorded. CI installs Chromium and runs this suite after the full build in `npm run verify`. The separate `npm run smoke` checks built-service startup.

Automated checks do not certify screen-reader behavior or every browser engine. Consult the [current validation limits](design-system/validation.md) for remaining coverage gaps. Report each run in the change summary, PR, or CI; update that document only when a gap changes.

## Migrations

Schema definitions live under `packages/database/src/schema`. Generate SQL with Drizzle Kit, inspect the generated SQL and metadata, and commit both. Apply migrations explicitly; the API does not mutate the schema during startup.

Never edit an applied migration or use schema push as a substitute for reviewed SQL. Better Auth schema generation will feed this same migration history when authentication is implemented.

Migration `0002_game_command_receipts.sql` creates the shared accepted-command receipts and backfills existing moves. Stop old API writers before applying it, then start the API version that writes receipts for every move and lifecycle action. See [ADR-0007](decisions/0007-lifecycle-recovery-and-private-replay.md). Integration tests exercise this backfill on a populated prior schema, receipt uniqueness, cascading deletion, and atomic rollback.

Migration `0003_ai_turn_persistence.sql` adds game modes, independent AI seat configuration, normalized invocation attempts, and leased turn reservations. Existing human sandbox records retain their identity, authority, history, receipts, and unfinished-game slot; their mode defaults to `human_vs_human`. Unconfigured legacy AI placeholder seats are rejected, not assigned a fabricated provider/model. The reviewed SQL creates composite unique indexes before their referencing foreign keys. Stop old writers while migrating and restart with the reservation-aware repository. Run `npm run db:check` and `npm run test:integration` to verify metadata, populated-schema upgrades, migration/write rollback, constraints, and concurrent ownership/recovery across independent pools.

The internal AI persistence operations and caller responsibilities are defined in [ADR-0009](decisions/0009-ai-turn-persistence.md) and its [stepping/retry extension](decisions/0010-ai-paused-stepping-and-retry-accounting.md). They run inside the existing game transaction interface; provider calls must run outside it. The [guest AI service](#guest-ai-game-api) composes these operations without another schema migration. Use only normalized mock outcomes in automated persistence tests, and never pass credentials or raw provider objects into repository calls.

## Logging and errors

The API logger omits request bodies, retains only method/path/request ID for requests, strips URL queries, and recursively redacts credential-like object fields. Raw exceptions are reduced to a safe name and non-secret code before serialization; the error serializer preserves only those diagnostic fields when it receives an already-sanitized record.

Idle PostgreSQL pool errors write a fixed, credential-free diagnostic to stderr without terminating the API. The pool remains available for new connections, and `/ready` checks current database availability on every request, returning `503` when its query fails.

System errors retain `code`, `message`, and `requestId`. Structured game errors use the same envelope with enumerated codes; only `GAME_CONFLICT` additionally requires an already-authorized `currentSnapshot`. Messages come from the API's English error catalog, never domain/engine exceptions. Domain failures expose codes and, for an invalid history entry, its one-based ply only. No error accepts arbitrary details or raw exception payloads. Guest/game responses are `no-store`, and the raw guest token appears only in its cookie. Corrupted persisted history or projections yield a safe `500` and leave game data unchanged. Add logging and error tests whenever a new boundary accepts credentials or provider payloads.
