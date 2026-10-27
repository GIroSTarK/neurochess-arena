# Development guide

Start here for local setup, contribution boundaries, verification and schema changes. Use the focused references for [HTTP and WebSocket contracts](reference/http-api.md), [provider adapters and pricing](reference/providers.md), [browser integration](reference/browser.md), and [test environments and acceptance](reference/testing.md). Product behavior, architecture and release status remain in their [canonical documents](../AGENTS.md#sources-of-truth).

## Local setup

Use Node.js 24 (24.5 or newer) and npm 11. From a clean clone:

```text
npm ci
```

Build, watch, and type-check commands use the native TypeScript 7 compiler through the `@typescript/native` npm alias, which provides `tsc`. Keep `typescript` aliased to `@typescript/typescript6` so ESLint and dependency-cruiser can use the TypeScript 6 compiler API. Retain both aliases when updating the toolchain; see the [upstream compatibility guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0).

Review root `overrides` against the installed upstream dependency ranges during upgrades. Drizzle Kit's deprecated `@esbuild-kit/esm-loader` / `@esbuild-kit/core-utils` dependency chain still requests esbuild 0.18; retain the scoped override selecting 0.25.12 to address [GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99). Remove it only once upstream no longer requires the affected range. The loader deprecation warnings remain until Drizzle Kit removes those dependencies. Concurrently 10.0.6 already pins `shell-quote` 1.12.0, so it needs no override. Inspect audit recommendations before using `npm audit fix --force`, which may select incompatible releases.

Use `npm ls --all`, `npm outdated --workspaces --include-workspace-root`, and `npm find-dupes --package-lock-only` when reviewing dependencies. Matching declarations in separate workspaces express each package's own requirements; they do not imply separate installed copies. Keep incompatible transitive version ranges separate instead of adding overrides solely to force deduplication.

`allowScripts` approves esbuild's binary installation for the exact versions in the lockfile. After upgrading dependencies, inspect `npm approve-scripts --allow-scripts-pending` and review changed install scripts before updating those pins. Verify with `npm ci` and `npm audit`.

Copy `.env.example` to `.env`. The committed values are local placeholders only; never place production credentials in the repository.

Set `BETTER_AUTH_SECRET` to a cryptographically random value of at least 32 characters (for example, 32 random bytes encoded as base64). Store it only in the local environment or deployment secret storage; keep it stable across API restarts. The API refuses to start without it. Set `BETTER_AUTH_URL` to the public API origin.

Start PostgreSQL and wait for its health check:

```text
npm run infra:up
```

Apply the reviewed migration history, then start the TypeScript package watchers, Fastify API, and Vite app:

```text
npm run db:migrate
npm run dev
```

The API reads the root `.env` file when present. Vite also uses the root as its environment directory and exposes public `VITE_` variables plus the explicitly selected `SANDBOX_ENABLED` flag.

## Environment contract

| Variable                                                    | Consumer   | Purpose                                                                                                                                                                  |
| ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                                  | API        | `development`, `test`, or `production`                                                                                                                                   |
| `NODE_TLS_REJECT_UNAUTHORIZED`                              | Node/API   | Leave unset; production rejects `0`, which disables TLS certificate verification                                                                                         |
| `API_HOST`                                                  | API        | Fastify listen address                                                                                                                                                   |
| `API_PORT`                                                  | API        | Fastify listen port                                                                                                                                                      |
| `TRUSTED_PROXY_IP`                                          | API        | Exact direct reverse-proxy IPv4/IPv6 address; required in production, unset for direct local development requests                                                        |
| `WEB_ORIGIN`                                                | API        | Exact browser origin allowed by CORS                                                                                                                                     |
| `BETTER_AUTH_URL`                                           | API        | Explicit public API origin; auth is mounted at `/api/auth`                                                                                                               |
| `BETTER_AUTH_SECRET`                                        | API        | Required random signing/encryption secret, at least 32 characters                                                                                                        |
| `CREDENTIAL_ENCRYPTION_KEY_ID`, `CREDENTIAL_ENCRYPTION_KEY` | API        | Optional complete pair enabling provider-key saving: 1–64 ASCII letters/digits/underscore/hyphen identifier and canonical base64 of exactly 32 random bytes; server-only |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                  | API        | Optional complete pair enabling Google sign-in; server-only                                                                                                              |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                  | API        | Optional complete pair enabling GitHub sign-in; server-only                                                                                                              |
| `AUTH_EMAIL_TRANSPORT`                                      | API        | `disabled` (default outside production) or `smtp`; production requires `smtp`                                                                                            |
| `AUTH_EMAIL_FROM`                                           | API        | One valid sender email address; required with SMTP                                                                                                                       |
| `SMTP_HOST`                                                 | API        | SMTP hostname or IP, without a URL, credentials, or path; required with SMTP                                                                                             |
| `SMTP_PORT`                                                 | API        | SMTP port, 1–65535; defaults to 587                                                                                                                                      |
| `SMTP_SECURITY`                                             | API        | `starttls` (default), `tls`, or local development/test `none`                                                                                                            |
| `SMTP_USER`, `SMTP_PASSWORD`                                | API        | Optional SMTP credentials; supply both or neither; server-only secrets                                                                                                   |
| `DATABASE_URL`                                              | API, tools | PostgreSQL connection URL                                                                                                                                                |
| `LOG_LEVEL`                                                 | API        | Pino log level                                                                                                                                                           |
| `SANDBOX_ENABLED`                                           | API, web   | Exactly `true` or `false`; defaults to false; production API rejects true                                                                                                |
| `GUEST_SESSION_TTL_SECONDS`                                 | API        | Inactivity expiry, 1–31536000 seconds; defaults to 86400                                                                                                                 |
| `VITE_API_BASE_URL`                                         | web        | Public HTTPS API origin (HTTP allowed only for `localhost`), without credentials, non-root paths, query, or fragment                                                     |
| `POSTGRES_*`                                                | Compose    | Local database name, user, password, and port                                                                                                                            |
| `TEST_DATABASE_URL`                                         | Tests      | Explicit disposable PostgreSQL database ending in `_test`; no fallback                                                                                                   |
| `TEST_POSTGRES_PORT`                                        | Compose    | Separate test-service port, defaults to 5433                                                                                                                             |

Invalid environment errors contain variable names only. Never add server secrets to a `VITE_` variable.

The web entrypoint validates `VITE_API_BASE_URL` before creating the router or API clients. Invalid origins render the localized configuration error with the variable name only. The HTTP exception is exactly `localhost`, not loopback IPs, LAN addresses, or localhost subdomains; a root trailing slash is allowed.

The API's `BETTER_AUTH_URL` and `WEB_ORIGIN` accept HTTPS, or HTTP `localhost` outside production. Credentials, paths, trailing slashes, wildcards, queries, and fragments are rejected. Production enforces HTTPS and same-site browser/API origins, including private public-suffix entries; use `localhost` consistently during development. Production database URLs require exactly one `sslmode=verify-full`, optionally with a mounted `sslrootcert`, and reject ambiguous TLS overrides. `NODE_TLS_REJECT_UNAUTHORIZED=0` is rejected in production. Trusted auth origins and credentialed CORS use the exact `WEB_ORIGIN`, never a request-supplied Host or forwarded header. Production requires `TRUSTED_PROXY_IP`; Compose supplies Caddy's fixed address. Leave it unset for direct local requests. The [proxy trust contract](operations.md#host-and-network) defines forwarded client-IP validation and the shared identity used by auth, HTTP limits and socket admission.

Vite explicitly exposes only `SANDBOX_ENABLED` in addition to the public `VITE_` variables. Both applications read the same root `.env`; no second Sandbox flag is needed. Restart development services after changing it, or rebuild the web bundle and restart the API when using `npm start`. The web value is fixed at Vite startup/build time; API checks still apply if the configurations differ.

## Root commands

| Command                         | Purpose                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `npm run dev`                   | Build shared packages, watch them, and run both applications            |
| `npm run build`                 | Build shared packages, the API, and the Vite production bundle          |
| `npm start`                     | Run the built API and web preview                                       |
| `npm run lint`                  | Run ESLint with zero warnings                                           |
| `npm run typecheck`             | Type-check project references and tests                                 |
| `npm test`                      | Run unit, PostgreSQL integration, and dependency-boundary checks        |
| `npm run test:unit`             | Run database-free unit tests                                            |
| `npm run test:integration`      | Run required PostgreSQL-backed tests; fail if unavailable               |
| `npm run test:e2e`              | Run desktop/mobile browser gameplay and accessibility checks            |
| `npm run test:performance`      | Check production bundle, worker and replay lab budgets                  |
| `npm run format:check`          | Verify Prettier formatting                                              |
| `npm run docs:check`            | Check documentation links, anchors and documented environment variables |
| `npm run verify`                | Run formatting, documentation, lint, types, tests, and build            |
| `npm run smoke`                 | Start and probe both built services                                     |
| `npm run build:deployment:test` | Build API/Caddy images for the isolated production rehearsal            |
| `npm run test:deployment`       | Rehearse actual production containers and all browser engines           |
| `npm run infra:up`              | Start and health-check PostgreSQL                                       |
| `npm run infra:test:up`         | Start the isolated disposable test PostgreSQL service                   |
| `npm run infra:down`            | Stop PostgreSQL while preserving data                                   |
| `npm run db:generate -- ...`    | Generate a named Drizzle migration                                      |
| `npm run auth:generate`         | Regenerate Better Auth's Drizzle schema without database access         |
| `npm run db:check`              | Check migration metadata for consistency                                |
| `npm run db:migrate`            | Apply pending migrations                                                |
| `npm run db:studio`             | Open Drizzle Studio                                                     |

## Dependency direction

- `apps/web` may consume `packages/contracts` and presentation-safe exports from `packages/chess`.
- Browser production modules in `apps/web/src` cannot import Node built-ins, server libraries listed in the architecture guards, or test modules. Build/config files outside `src`, `*.test.*` files, and `src/test/` helpers may use Node and server libraries.
- `apps/api` may consume `packages/contracts`, `packages/chess`, and `packages/database`.
- Production API modules in `apps/api/src` and operational scripts in `scripts/monitoring` and `scripts/recovery` cannot import first-party test support: app/package `test/` or `src/test/` directories, root `test/` or `test-fixtures/`, or `*.test.*` files. Colocated tests and each production area's own `test/` helpers are excluded from those production categories.
- Deployment rehearsals and the architecture fixture runner are outside the production operational category; they and API tests may use test infrastructure, including database helpers.
- `packages/contracts` and `packages/chess` are infrastructure-independent leaves.
- `packages/database` is server-only and does not depend on application code.
- Product packages expose explicit entrypoints; consumers must not deep-import their source files.
- Web features may import other features only through the paths declared in `dependency-cruiser.config.mjs`; route-tree and shared onboarding composition belong in `app/`.
- Keep routing services in `routing/` and page-shell presentation in `shell/`, following the enforced [routing boundaries](architecture/browser.md#browser-routing).

Use kebab-case filenames throughout `apps/web`, including React components and hooks (`match-screen.tsx`, `use-sandbox.ts`). Keep exported React component names in PascalCase and hooks in camelCase. Colocate tests with the matching filename and `.test.ts` or `.test.tsx` suffix; dotted suite qualifiers such as `controller.commands.test.ts` remain supported.

`npm run test:architecture` scans `apps`, `packages`, and `scripts`, including standalone monitoring/recovery entrypoints and external dependency edges without traversing dependency implementations. Deliberately invalid fixtures live outside those roots and prove the web/database boundary, both independent leaves, rules-engine encapsulation, all three public package entrypoints, browser/shared-package infrastructure restrictions, and exclusion of test support (including scripted providers) from production API, operational, web, and chess imports. Allowed fixtures protect web build/config exceptions, API test composition, operational package imports, and deployment/fixture-runner test infrastructure. Backend feature ownership and resource-lifetime ordering remain conventions checked by review and behavior tests; no API feature-import matrix is enforced.

## Chess domain development

The [domain and core contract boundary](architecture/games.md#deterministic-domain-and-core-contracts) remains independent of HTTP and persistence. The API now consumes it through the guest command service. Import only package entrypoints. `createGame()` starts in `configuring`; call `start()` before submitting canonical UCI. Snapshot and command results contain copied data. `restoreGame({ moves, lifecycle })` replays ordered UCI moves and validates the supplied lifecycle instead of accepting a cached FEN or PGN.

Focused checks require neither PostgreSQL nor provider credentials:

```text
npm exec vitest -- run packages/chess/test packages/contracts apps/api/src/game-contracts.test.ts
npm run test:architecture
```

Special-position fixtures live in `packages/chess/test`, outside the production TypeScript root and package exports. They exercise the internal adapter through the same aggregate used by public factories. Do not export a FEN constructor, import fixtures into production, or replace the normalized repetition key with the engine's built-in hash. The regression tests cover pinned en passant, restoration between repetition cycles, and the 99-to-100 half-move boundary.

## Verification

Run focused checks while iterating, then the full configured baseline before handing off a change:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run verify` also checks formatting and documentation. PostgreSQL-backed checks require the dedicated disposable test service and `TEST_DATABASE_URL`; follow the [integration setup](reference/testing.md#postgresql-integration-tests). Run integration and browser suites sequentially because their lifecycle checks share ports. Add or update behavior tests at the affected boundary, then use the [testing reference](reference/testing.md) for unit environments, browser acceptance, CI and release evidence.

## Migrations

Migration `0022_model_alias_prefix.sql` permits one leading `~` in model IDs for game participants and invocation records, matching OpenRouter aliases and the shared transport contract. It replaces only the two ID checks, preserves existing rows, and retains the 256-character limit. Stop API writers, apply the forward migration, and restart the updated API together: older readers reject alias IDs. Apply it before creating games with alias models.

Migration `0020_private_analysis_samples.sql` adds normalized account/game/ply samples, bounded scalar/score checks and account/game deletion cascades without rewriting existing records or backfilling evaluations. Stop old API writers, apply the reviewed forward migration, and restart the updated API together. Room history removal now deletes the requester's samples in the same retained-access transaction; account and physical game deletion cascade the rest. The test suite verifies a populated upgrade, schema constraints, rollback and deletion races on disposable databases.

Migration `0019_room_http_commands.sql` adds identity-free accepted-join receipt fields to rooms and command kinds for join and invitation changes. Existing room metadata, creation operations, history, slots, moves and solo command receipts are preserved. Stop old API writers, apply the reviewed forward migration, commit it before using the new enum values, and start the updated API. Only the consumed invitation digest and command UUID are stored for join recovery; current seat/access checks still authorize every retry. No data backfill or personal development database migration is required for the test suite.

Migration `0018_shared_room_history.sql` adds participant-specific room history access and backfills every seated account in existing human games, including waiting and terminal records. Stop old API writers, apply the reviewed migration, and restart the updated API together. Shared writes, history removal and account deletion now take the shared-room gate before identity/game locks. Account deletion preserves anonymized opponent entitlements; guest-only terminal cleanup runs after account/history deletion, on startup and every 30 seconds, rechecking expiry under the guest lock. Guest renewal also rechecks expiry after acquiring that lock. The migration does not enable public room admission.

Migrations `0016_participant_game_slots.sql` and `0017_backfill_participant_game_slots.sql` add normalized unfinished-game reservations and backfill active/paused owners and human participants, including seatless AI owners and the independent guest Sandbox scope. Apply both together with all old API writers stopped, then start the updated API: old writers do not maintain reservations. Existing owner uniqueness indexes remain in place; participant identity/scope uniqueness additionally protects cross-mode reservations. A conflicting pre-existing participation makes the upgrade fail atomically and must be resolved before retrying; the backfill never drops a participant or chooses a winning game. Reservation and game/seat insertion share a transaction, terminal position updates release every game slot, and physical deletion cascades them. Room admission remains disabled until the subsequent shared-retention and room API work is complete.

Migration `0015_private_room_foundation.sql` extends the existing mode enum with `human_vs_human` and adds digest-only room metadata and bounded account creation-operation records. It preserves existing game data and unfinished-owner indexes. Only terminal human games may lack an owner; unfinished human games require an account owner, and solo/Sandbox ownership stays unchanged. Game deletion cascades room metadata but only clears a creation operation's result reference; account deletion removes that operation. Stop API writers, apply the reviewed forward migration, and restart the updated API together. This migration does not enable room creation or joining; follow the [Phase 4 delivery order](roadmap.md#phase-4--private-online-human-games) before enabling shared writes.

Migration `0014_account_history_index.sql` adds a partial account/terminal-timestamp/UUID index for private history, without rewriting rows. Stop API writers while applying the forward migration and restart afterward; ordinary index creation can block writes on a populated database. The migration test upgrades populated prior schemas and checks that all application/authentication rows remain unchanged.

Schema definitions live under `packages/database/src/schema`. Generate SQL with Drizzle Kit, inspect the generated SQL and metadata, and commit both. Apply migrations explicitly; the API does not mutate the schema during startup.

Migration `0021_invocation_cost_estimates.sql` adds nullable billing/provenance and exact monetary columns to existing attempts. Prior rows keep all original measurements and receive an explicit `legacy_record` cost state; there is no price or usage backfill. Stop API writers, apply the generated migration, and restart the updated API together. Older writers remain structurally compatible but cannot capture price provenance. Populated upgrade and existing deletion cascades are tested, and integration setup applies migrations twice to verify repeatability.

Migration `0013_owner_scoped_credential_ids.sql` replaces global credential-ID uniqueness with the composite `(user_id, id)` primary key. It preserves all IDs, ownership, metadata and encrypted envelopes without re-encryption. Stop every API writer, apply the reviewed forward migration, then restart only the updated API: old writers use `ON CONFLICT (id)`, which is incompatible with the new key. Keep `0012` unchanged. Populated-schema tests preserve existing data and decrypt a migrated credential; independent accounts can then use the same ID while same-account duplicates remain rejected.

Migration `0012_provider_credentials.sql` adds the account-owned credential table, owner/creation index, bounded envelope checks and owner cascade; it does not rewrite existing auth/profile/game data. Stop API writers, apply the reviewed migration, configure the optional encryption pair, then restart the updated API. Populated-schema tests compare all prior records before/after this migration; fresh/repeated migrations run in integration setup. Built-in auth deletion remains disabled in favor of the application-owned [account deletion](reference/http-api.md#account-deletion) path.

Migration `0011_profiles.sql` adds a private profile row keyed to the auth user, nullable display/normalized username, sticky avatar-removal preference, validation check and unique normalized-name index. It leaves populated auth/game tables and existing provider images unchanged, and never infers usernames. Existing accounts must complete onboarding before account game/provider access, including recovery. Stop all API writers, apply the reviewed migration, and restart the updated API together; old binaries bypass the new onboarding requirement. Guest/Sandbox access and server-side controller cleanup remain available. Populated-schema tests preserve account owners, human seats, guest games and execution records; fresh/repeated migration runs are part of integration setup.

Migration `0010_account_owned_games.sql` adds nullable account owner/participant foreign keys, exactly-one-owner and guest-only Sandbox checks, exclusive human-seat identities, and a partial unique unfinished-account index. It preserves every existing guest owner/seat and game execution record; no ownership is transferred. Stop API writers, apply it, and restart the updated API together. Old binaries must not read account games because they assume non-null guest ownership. Integration tests upgrade populated legacy game/auth tables and retain moves, receipts, reservations, controllers, logical turns, and invocation attempts. Use the application-owned [account deletion](reference/http-api.md#account-deletion) path to remove owned games before deleting their auth user.

Migration `0009_oauth_account_identity.sql` adds a unique `(provider_id, account_id)` index, preventing one provider identity from acquiring multiple owners. It does not rewrite accounts, sessions, verification records, or games. Stop API writers, apply it, and restart before enabling OAuth. Duplicate bindings fail migration instead of being silently merged; investigate them before retrying. Retain this Arena-specific index after regenerating the library schema. Integration tests upgrade populated pre-OAuth auth/game tables and exercise duplicate-binding rejection.

Migration `0008_better_auth_foundation.sql` adds generated Better Auth user/account/session/verification and rate-limit tables, with auth foreign keys and indexes; it does not rewrite guest identities or games. Stop API writers, apply the reviewed migration, configure the auth origin/secret, and restart the updated API. Integration coverage upgrades populated legacy game schemas and verifies guest ownership, seats, moves, receipts, reservations, and controller records remain intact.

Migration `0007_separate_sandbox_game_slot.sql` replaces the unfinished-owner index with a unique `(owner_guest_session_id, is_sandbox)` index for active/paused games. It does not rewrite game data. Stop old API writers, apply it, and restart the updated API so creation and discovery consistently use their own group. See [ADR-0012](decisions/0012-independent-sandbox-game-slot.md) for the contract and rollback constraint.

Migration `0006_ai_controller_presence.sql` adds the per-game controller UUID/expiry table and cascading foreign key. It does not rewrite existing games or Sandbox data. Stop old API writers, apply it, and restart the updated API; active ordinary AI games without a lease are then paused by the presence worker. Never expire a reservation into another provider dispatch. The [controller ADR](decisions/0011-ai-controller-presence-and-step.md) defines recovery and deployment behavior.

Never edit an applied migration or use schema push as a substitute for reviewed SQL. Better Auth schema generation feeds this same migration history.

Migration `0002_game_command_receipts.sql` creates the shared accepted-command receipts and backfills existing moves. Stop old API writers before applying it, then start the API version that writes receipts for every move and lifecycle action. See [ADR-0007](decisions/0007-lifecycle-recovery-and-private-replay.md). Integration tests exercise this backfill on a populated prior schema, receipt uniqueness, cascading deletion, and atomic rollback.

Migration `0003_ai_game_configuration.sql` adds nullable ordinary AI mode and participant configuration columns with strict field constraints. Existing human-seat games, including Sandbox in every lifecycle state, receive null configuration fields; their marker, assignments, history, receipts, and owner index remain unchanged. It neither infers providers nor grants Sandbox authority. Unsupported pre-existing AI fixture rows without configuration fail the migration instead of receiving invented settings; recreate those disposable fixtures with explicit provider/model/parameters. Stop API writers, apply the forward migration, and restart the updated API before creating AI records through the service. Old APIs do not validate AI configuration and must not serve those records. Ordinary AI HTTP creation and provider operations remain outside the Sandbox API surface.

Migration `0004_ai_turn_reservations.sql` adds a separate execution-reservation table without modifying existing game data. Stop old API writers, apply the migration, and restart the updated API before enabling AI execution; all ordinary-game writers must invalidate reservations with accepted revisions. Do not delete or expire orphaned reservations to retry inference. Recover through the owner-authorized Pause/Resume path in [ADR-0009](decisions/0009-ai-turn-reservations.md). Integration tests kill a separate executor process and verify recovery, late-result fencing, write rollback, and lost-acknowledgement deduplication using only injected adapters and the disposable database.

Migration `0005_ai_invocation_policy.sql` adds logical AI turns and normalized invocation attempts plus the internal `technical_loss` receipt kind. Stop API writers, apply the generated migration, and restart the updated API before dispatching AI turns. Existing Sandbox/AI records and reservations remain unchanged; historical invocations are not backfilled with invented measurements. Existing uncertain reservations still require explicit Pause/Resume recovery. See [ADR-0010](decisions/0010-ai-failure-policy-and-invocations.md) for retry budgets, interrupted attempts, and atomic outcomes. The private `GameService.invocations` read returns safe attempt data; provider failures return an authoritative paused snapshot from `aiTurn`. The [AI HTTP routes](reference/http-api.md#ai-provider-and-game-api) expose these contracts without another migration.
