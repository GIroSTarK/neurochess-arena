# Development guide

## Local setup

Use Node.js 24 and npm 11. From a clean clone:

```text
npm ci
```

Build, watch, and type-check commands use the native TypeScript 7 compiler through the `@typescript/native` npm alias, which provides `tsc`. Keep `typescript` aliased to `@typescript/typescript6` so ESLint and dependency-cruiser can use the TypeScript 6 compiler API. Retain both aliases when updating the toolchain; see the [upstream compatibility guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0).

Retain the root `overrides` and `allowScripts` fields during dependency upgrades. Drizzle Kit's deprecated `@esbuild-kit/esm-loader` / `@esbuild-kit/core-utils` dependency chain still requests esbuild 0.18; the scoped override selects 0.25.12 to address [GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99). The loader deprecation warnings remain until Drizzle Kit removes those dependencies. Recheck upstream before removing the override, and inspect audit recommendations before using `npm audit fix --force`, which may downgrade Drizzle Kit to an incompatible release.

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

The API reads the root `.env` file when present. Vite also uses the root as its environment directory but exposes only variables prefixed with `VITE_`.

## Environment contract

| Variable                                                    | Consumer   | Purpose                                                                                                                                                                  |
| ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                                  | API        | `development`, `test`, or `production`                                                                                                                                   |
| `API_HOST`                                                  | API        | Fastify listen address                                                                                                                                                   |
| `API_PORT`                                                  | API        | Fastify listen port                                                                                                                                                      |
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
| `VITE_API_BASE_URL`                                         | web        | Public HTTP(S) API origin, without credentials, paths, query, or fragment                                                                                                |
| `POSTGRES_*`                                                | Compose    | Local database name, user, password, and port                                                                                                                            |
| `TEST_DATABASE_URL`                                         | Tests      | Explicit disposable PostgreSQL database ending in `_test`; no fallback                                                                                                   |
| `TEST_POSTGRES_PORT`                                        | Compose    | Separate test-service port, defaults to 5433                                                                                                                             |

Invalid environment errors contain variable names only. Never add server secrets to a `VITE_` variable.

Auth/API and browser origins accept HTTPS, or HTTP `localhost` outside production. Credentials, paths, trailing slashes, wildcards, queries, and fragments are rejected. Production requires HTTPS and a same-site browser/API deployment for the cookie policy; use `localhost` consistently during development. Trusted auth origins and credentialed CORS use the exact `WEB_ORIGIN`, never a request-supplied Host or forwarded header. No proxy is trusted by default; deployments behind one must deliberately define that boundary before relying on client-specific rate limits.

Vite explicitly exposes only `SANDBOX_ENABLED` in addition to the public `VITE_` variables. Both applications read the same root `.env`; no second Sandbox flag is needed. Restart development services after changing it, or rebuild the web bundle and restart the API when using `npm start`. The web value is fixed at Vite startup/build time; API checks still apply if the configurations differ.

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
| `npm run auth:generate`      | Regenerate Better Auth's Drizzle schema without database access  |
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

## Sandbox UI

Set `SANDBOX_ENABLED=true` in the local `.env`, apply migrations, and run `npm run dev`. Open `http://localhost:5173`, choose **Sandbox** in the header, then **Start sandbox**, or open `http://localhost:5173/sandbox` directly. Arena at `/` provides the separate [AI-versus-AI flow](#arena-controller-api); loading setup reads unfinished-game discovery without creating a guest. When disabled, Sandbox is absent from navigation and direct links show an unavailable page without mounting the game client. The Sandbox service indicator checks the database through `/ready`; API creation and access checks remain authoritative if web and API settings differ.

One guest controls White and Black. Select a source and a highlighted destination, or use the [board keyboard controls](design-system.md#keyboard-and-chess-interaction). Promotion always requires an explicit piece choice. Flip board changes presentation only. Pieces, turn, result, and SAN history stay unchanged until an authoritative response arrives.

The entry screen shows a read-only standard-position preview. Its single **Start sandbox** action sits in the desktop rail and before the board on mobile; inspecting the preview never creates a guest session or submits moves. Sandbox has its own [unfinished-game limit](product.md#development-sandbox): starting or recovering it does not select or modify an unfinished Arena game, and an unfinished Sandbox does not block Arena setup.

An uncertain submission keeps the original move or lifecycle command in memory. **Check game status** reads the authorized snapshot; **Retry same move** or **Retry same command** reuses the original ID, version, and payload. A same-version GET is still uncertain because the first request could commit later. Rejections also require synchronization before another command. Access loss clears the private position, replay, and export text, returns to the standard-position preview, and requires **Start sandbox again**.

Creation updates the private URL to `/sandbox?game=<uuid>`. Refresh, reopening that URL, or opening `/sandbox` with an existing guest discovers the game without bootstrapping a new guest. Visiting Arena leaves the game unchanged; returning to Sandbox uses paused recovery. Recovery pauses an active game through a versioned command before enabling controls; an already-paused game requires no write. Choose **Resume** explicitly to continue. Concurrent active snapshots are reconciled with at most three pause attempts before **Retry recovery** is offered. An uncertain pause follows the same command retry flow as a move.

**Pause** and **Resume** preserve the position and history. **Abort**, **Resign White**, and **Resign Black** are available while active or paused. The confirmation dialog initially focuses Cancel and explains the outcome. Abortion displays **Game stopped**, keeps result `*`, and releases the unfinished-game slot. Resignation awards the other color the win, including when the resigning color is off-turn.

Completed and aborted games show their result and termination reason, open replay at the final ply, and offer **First**, **Previous**, **Next**, **Last**, and selectable SAN moves. Replay changes only the displayed position. **Copy PGN** and **Download PGN** fetch the private, authorized export endpoint; clipboard failure reveals selectable text. A download contains the canonical UTF-8 text in `neurochess-<uuid>.pgn`. **New game** preserves the previous record and private URL; browser Back can reopen it. Access remains limited to the owning guest until the existing inactivity expiry (24 hours by default). This development flow exposes no recent-games list and performs no retention cleanup.

Visible copy and document metadata come from `apps/web/src/i18n/en.ts`. Use complete messages and named placeholders; keep UCI, SAN, and coordinates unchanged. The i18next resource declaration type-checks keys, falls back to English, and ships no browser-language detection. Inter and Orbitron are bundled locally. API error codes map to catalog entries; do not display server messages or caught exceptions.

Presentation uses Tailwind CSS utilities in JSX. The [design-system tokens](design-system.md#foundations), base layer, and the few custom utilities live in `apps/web/src/styles.css`; shared controls sit under `apps/web/src/ui`. Prettier sorts class names, so run `npm run format` after editing markup. Tests select elements by role, accessible name, or data attribute rather than by class.

## Arena reference scenarios

With `SANDBOX_ENABLED=true` and Vite running in development, open [the arena reference screen](http://localhost:5173/dev/arena). This page needs no running API, database, guest session, or provider key. Production builds and Sandbox-disabled apps show the unavailable page at this URL.

Choose Human vs human, AI vs human with either human color, AI vs AI, or identical models with long names. Live and Replay use the same shared components as Sandbox. The board is for inspection; Pause/Resume, flip, confirmed resignation/abort, and replay navigation affect only the in-memory fixture. The chess package derives all positions and results from the standard-position sample game. Reloading or selecting another scenario resets the fixture.

All sample identities, commentary, and measurements are explicitly labeled **Test data**. Human seats omit AI details; only the supplied human seat receives a resignation action. AI scenarios exercise commentary/telemetry slots and opt-in Moves/Analysis/Events tabs. Replay synchronizes sample details with the selected position. Missing commentary, missing usage/pricing, and the initial position have explicit empty/unavailable states. Analysis is a labeled extension slot; no Stockfish or provider is invoked.

The reference adapter and data live in `apps/web/src/reference`; reusable composition lives in `arena/ArenaDetails.tsx` and `ui/DetailTabs.tsx`. Keep fixture data and adapters out of shared presentation components. Cover every scenario's seat/capability mapping in `apps/web/src/reference/ArenaReferenceScreen.test.tsx`; extend `test/e2e/arena-reference.spec.ts` when a new capability needs browser-specific geometry, scrolling, or native interaction coverage. This is a UI reuse check, not acceptance of real AI orchestration or room permissions.

## Account session foundation

`GET /api/auth/get-session` accepts no query fields and returns `{ user: { id, email, emailVerified }, session: { expiresAt } }`, or `null` for a missing, forged, expired, or revoked session. The response excludes session tokens and provider/profile metadata. `POST /api/auth/sign-out` requires JSON `{}`, an exact `WEB_ORIGIN`, and the account cookie; it invalidates the session and clears its cookies. The web client also sends `x-neurochess-expected-account` with the account displayed before sign-out; a mismatch returns `401 AUTH_UNAUTHORIZED` without revoking or clearing the replacement cookie. Both use `credentials: "include"`, `Cache-Control: no-store`, localized `AUTH_*` errors, and `Referrer-Policy: no-referrer`. Preserve every returned Set-Cookie header in server integrations.

The [email lifecycle endpoints](#emailpassword-api) below are available when an email sender is configured, and the [OAuth endpoints](#google-and-github-oauth) when the selected provider is configured. Other auth paths remain unavailable. The server account resolver supplies account authority to the [game API](#ai-provider-and-game-api); Sandbox retains guest authority. Cookie caching is disabled, and account linking and deletion are disabled. Session lifetime, cookie policy, and endpoint protections are described in [authentication architecture](architecture.md#authentication-and-guest-sessions).

The pinned Better Auth runtime, Drizzle adapter, and `auth` schema generator are 1.7.6, compatible with stable Drizzle ORM 0.45.3 and Kit 0.31.10. Use `npm run auth:generate`, review `packages/database/src/schema/auth.ts`, preserve Arena's `account_provider_subject_unique` index, then `npm run db:generate -- --name <change>` and inspect the generated SQL. The generation-only config shares runtime options but uses non-deployment placeholders and never connects to a database. Do not run Better Auth's migrate command or Drizzle schema push. Runtime/adapter/generator upgrades must be reviewed together, including the OAuth policy plugin's use of provider methods and server-controlled state.

Focused verification: `npm exec vitest -- run --config vitest.integration.config.ts apps/api/test/auth.integration.test.ts apps/api/test/email-auth.integration.test.ts apps/api/test/auth-password-race.integration.test.ts packages/database/test/persistence.integration.test.ts`. Fixtures exercise the real auth service and disposable PostgreSQL, with an injected mailbox instead of outbound mail. Coverage includes cross-instance sign-in/reset races, reset rollback, and mail dispatch after successful registration commit. SMTP unit tests use a loopback test server, including rejected recipients and required STARTTLS. No real email credentials, paid providers, or OAuth calls are required.

### Email delivery setup

For a development SMTP mailbox listening on loopback port 1025, set `AUTH_EMAIL_TRANSPORT=smtp`, `AUTH_EMAIL_FROM=accounts@example.com`, `SMTP_HOST=localhost`, `SMTP_PORT=1025`, and `SMTP_SECURITY=none`. Leave both credential variables unset. The API does not log message bodies or links; inspect mail through your local SMTP server's mailbox. The default `disabled` setting keeps email routes closed and leaves guest flows and session lookup/sign-out available.

For an external SMTP service, configure its host, port, sender address, and credentials through the local environment or deployment secret storage. Select `starttls` (usually port 587) or `tls` (usually port 465). TLS certificates are verified; plaintext is allowed only for unauthenticated loopback delivery outside production. Production rejects a disabled sender, missing required fields, incomplete credentials, or plaintext transport. There is no runtime in-memory or console sender. The production vendor remains a deployment choice.

SMTP delivery starts after successful auth commit, with bounded connection/greeting/socket timeouts and no automatic send retry. Initiation responses acknowledge receipt without waiting for SMTP or reporting whether an address triggered delivery; display neither “email sent” nor “email delivered.” On failure, the API logs only the fixed `auth_email_delivery_failed` event with its request correlation; recipients, links, tokens, and raw sender diagnostics are excluded. Graceful shutdown waits for dispatched mail; abrupt termination can lose in-flight delivery, so users should wait a minute and request a new link if no email arrives. SMTP acceptance does not guarantee inbox delivery. A registration account can already exist after a send failure: recover with verification resend.

### Email/password API

All POSTs require JSON, the exact `WEB_ORIGIN`, and no query fields. Requests are strict: unknown fields, including callback URLs, profile names, and user IDs, are rejected. Success bodies never contain a session token, user profile, or reset/verification token. Fetch session details separately through the safe session endpoint.

| Endpoint                                 | Request                       | Success                                                   |
| ---------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| `POST /api/auth/sign-up/email`           | `{ email, password }`         | `200 { status: "accepted", message }`; no session         |
| `POST /api/auth/send-verification-email` | `{ email }`                   | Same generic acknowledgement                              |
| `GET /api/auth/verify-email`             | Query `{ token }`; email link | `303` to `${WEB_ORIGIN}/?auth=email-verified`; no session |
| `POST /api/auth/sign-in/email`           | `{ email, password }`         | `200 { success: true }` plus account cookie               |
| `POST /api/auth/request-password-reset`  | `{ email }`                   | Same generic acknowledgement                              |
| `POST /api/auth/reset-password`          | `{ token, newPassword }`      | `200 { success: true }`; revokes all existing sessions    |

The [product policy](product.md#emailpassword-lifecycle) defines password length, verification requirements, expiry, replay, and explicit sign-in. The internal Better Auth name starts empty; profile onboarding will collect the public username. Wrong credentials, unverified email, invalid/expired tokens, throttling, and authentication-service failure use localized `AUTH_*` codes; never display raw library errors. Recipient-specific email failures do not change initiation acknowledgements. Reset token consumption, password changes, and session revocation commit together. A server failure rolls them back; after an uncertain network result, a new reset request remains the recovery path if the token was already consumed. No success is acknowledged if session revocation fails.

Verification tokens occur only in the API email callback query and are removed from successful onward navigation. Reset email links use the fixed web path `/auth/reset-password` and a `token` fragment; the token belongs in the reset POST body, never a subsequent query or redirect. The account UI consumes and removes the reset fragment before rendering, then sends it only in the reset POST body. Invalid or expired verification links opened as HTML navigation redirect to a token-free `/?auth=verification-error&code=AUTH_*` page; JSON clients retain structured errors. All auth responses use `no-store` and `no-referrer`. Do not paste real links, passwords, or cookies into logs, shell command history, or bug reports.

### Google and GitHub OAuth

Set both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and/or both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Omit an entire pair to disable that provider; partial, blank, whitespace-containing, or control-character values fail startup without printing their contents. Keep secrets in the server environment or deployment secret storage. The callback URL is derived from validated `BETTER_AUTH_URL`, never a request Host or a separate redirect setting.

| Endpoint                                     | Request                                                                             | Result                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST /api/auth/sign-in/social`              | JSON `{ provider: "google" \| "github" }`, exact `WEB_ORIGIN`, credentials included | `{ url }` plus a state cookie; navigate to that URL in the same browser             |
| `GET /api/auth/callback/google` or `/github` | Provider authorization code/error and state, with the original state cookie         | `303` to `${WEB_ORIGIN}/?auth=signed-in`, or `/?auth=oauth-error&code=AUTH_OAUTH_*` |

The initiation schema rejects extra fields: no caller callbacks, scopes, direct ID tokens, linking data, or profile fields. GET callbacks accept bounded protocol fields; POST callbacks are unavailable. The authorization URL necessarily carries OAuth state to the provider; do not log or persist it. Onward navigation contains no code, state, provider description, token, or caller-selected URL. Error codes distinguish cancellation, unavailable verified email, an existing-account conflict, and other failures; display localized copy, never provider prose. Fetch `/api/auth/get-session` to confirm success. The account UI supplies both provider entry points and localizes these callback outcomes.

Provider-console setup:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), configure the OAuth consent screen/audience and a **Web application** OAuth client. Add `${BETTER_AUTH_URL}/api/auth/callback/google` as an authorized redirect URI (locally `http://localhost:3001/api/auth/callback/google`). Configure test users while the app is in testing. The API requests only `openid email profile`, online access, and no incremental grant expansion. See [Google setup](https://better-auth.com/docs/authentication/google).
2. In [GitHub Developer Settings](https://github.com/settings/developers), create an **OAuth App**, set the homepage to `WEB_ORIGIN`, and the authorization callback to `${BETTER_AUTH_URL}/api/auth/callback/github` (locally `http://localhost:3001/api/auth/callback/github`). Use separate apps for local and production callbacks. Only `user:email` is requested; no repository access or private-profile scope is needed. See [GitHub OAuth authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).
3. Apply migrations and restart the API with the matching credentials. Use HTTPS and same-site browser/API origins in deployment; use `localhost` consistently for local Secure cookies. Keep callbacks free of query/fragment additions in both consoles.

`apps/api/test/oauth-auth.integration.test.ts` runs the real Better Auth/Fastify/PostgreSQL flow with an injected fetch transport. It covers both providers, PKCE, signed state/expiry/replay/provider binding, cancellation and upstream errors, exact origins, private/malformed/unverified email, changed emails, account conflicts, password-recovery bypass prevention, token/profile redaction, concurrent creation, and sign-out. No live provider credentials or external OAuth traffic are used.

Manual live checks remain required for each deployment: complete Google and GitHub consent (including a GitHub account with a private email), cancel consent, retry after expiry, reject a same-email account conflict, confirm safe return navigation, and verify session lookup/sign-out and Secure cookie delivery in the target browser. Confirm the exact callback URI, intended client, audience/test-user access, and requested scopes in the actual consoles. Use the Google/GitHub entry points at `/auth/sign-in` for these manual checks. Mocked exchanges do not validate production consent, console configuration, or browser deployment behavior. Guest games remain separate under the [product policy](product.md#identity-changes-and-account-linking).

## Profile API

All profile routes require a valid account cookie (`credentials: "include"`). They derive the owner from the session; no user ID, email, provider identity, or URL is accepted in the body or query. Guests cannot read or mutate profiles. Responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; POSTs require JSON, the exact `WEB_ORIGIN`, no query fields, and at most 4 KiB.

| Method and path            | Request                                     | Result                                                                                   |
| -------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /profile`             | No query fields                             | Own username, completion and avatar metadata                                             |
| `POST /profile/onboarding` | `{ username, avatar?: "remove" }`           | Atomically claim a username under the [product policy](product.md#usernames-and-avatars) |
| `POST /profile`            | Nonempty `{ username?, avatar?: "remove" }` | Rename and/or permanently remove the imported avatar                                     |

Success returns `{ username: string | null, completed: boolean, avatar }`. An initials avatar is `{ source: "initials", initials }`; a provider avatar adds a validated `url` and uses `source: "google" | "github"`. Initials use the first two username characters in uppercase, or `?` before onboarding. The initial URL must belong to an actual linked provider: `googleusercontent.com` or one immediate subdomain for Google, or exactly `avatars.githubusercontent.com` for GitHub. It must use HTTPS without credentials, a nondefault port, fragment, whitespace or control characters. The API performs no image fetch or availability probe. Avatar consumers must use the initials fallback when an allowed image is unavailable and render usernames as text. Custom replacement URLs, uploads and avatar reimport are unavailable.

All authentication methods start incomplete; email/provider names never become usernames. A GET does not create a profile. Removing an avatar before choosing a username leaves onboarding incomplete. Concurrent case variants have one winner; `409 PROFILE_USERNAME_TAKEN` preserves the losing account's previous name and avatar. A successful rename releases the old name immediately. Other failures are `400 PROFILE_INVALID_REQUEST`, `401 PROFILE_UNAUTHORIZED`, `403 PROFILE_FORBIDDEN`, or `503 PROFILE_UNAVAILABLE`; display localized copy rather than response exceptions. The safe auth-session projection remains unchanged and intentionally separate from profiles.

Account game/provider operations, including reads and recovery, return `403 PROFILE_REQUIRED` until onboarding completes. Sign-out and profile access remain available. Guest and Sandbox flows remain usable. The [account UI](#account-ui) supplies shared onboarding and profile editing for all methods.

## Account UI

Use `/auth/sign-up`, `/auth/sign-in`, `/auth/verify`, `/auth/forgot-password` and `/auth/reset-password` for the email lifecycle, or the Google/GitHub buttons on the entry forms. Configure the corresponding API transports above; an unavailable method offers a safe error and another sign-in path. Registration and verification require a subsequent explicit sign-in. Request acknowledgements describe receipt, never guaranteed email delivery. The password reset form removes its token fragment immediately and requires a fresh sign-in after completion.

Every method reaches username onboarding before account gameplay. `/account` edits the private profile, renames the username, removes an imported avatar, and offers sign-out. Provider image failures use initials; uploads and arbitrary URLs remain unavailable. Public setup, game controls and recovery use account authority without guest bootstrap. Guest games remain separate, and Sandbox remains guest-only. [Provider keys](#credential-ui) opens account credential settings; [History](#private-game-history) opens private results and terminal game deletion. Account deletion remains a later milestone.

Sign-in/out, cross-tab changes, expiry and reset invalidation clear page keys and private state. The browser uses a non-secret sessionStorage account-intent marker, BroadcastChannel notifications, focus/pageshow checks and 15-second observation; API authorization remains authoritative on every operation. Public requests include `x-neurochess-identity` and `x-neurochess-expected-account` (observed UUID or `guest`); profile reads/updates and sign-out include the expectation. These optional expectations can only deny a changed identity, never supply one. Missing cookies on a previously authenticated page require sign-in or explicit guest continuation. Returning to an existing game requires paused recovery and fresh keys; login never resumes it automatically.

Run `npm run test:e2e -- test/e2e/accounts.spec.ts` against the isolated browser server for desktop/mobile email and injected Google/GitHub flows, profile editing, account play, paused return, session switching and reset revocation, late-response fencing, safe links, keyboard and enlarged-copy coverage. Test-only mailbox/OAuth routes and transports live in `test/e2e/account-harness.ts`; they are absent from production. Browser clients receive isolated fixture socket identities for the real database-backed rate limiter. Teardown tracks immutable user IDs from actual registration results and new-user OAuth callbacks, never email addresses encountered during reset or sign-in. It removes those users and their games, plus individually tracked sessions, reset/OAuth records and fixture rate-limit entries, after draining email work. No test sends real email or performs a live OAuth exchange; production consent and SMTP delivery still require the manual checks above.

## Private game history

`/history` lists completed and aborted account-owned public games together, with players, mode, terminal date, explicit state and result, and links to `/?game=<uuid>`. The human player uses the account's current username; stored provider/model identities describe AI seats. Guests see sign-in guidance explaining that guest games stay separate. Unfinished recovery remains in Arena. Signing out or switching accounts clears private rows and cancels obsolete requests.

`GET /games/history` requires a valid account session and completed profile, with the same expected-account assertion as other game reads. It accepts only `limit` (default 20, range 1–50) and an optional `cursor`. The response contains `games` summaries and `nextCursor` (null at the end). Results sort by terminal `updated_at`, then UUID, both descending. Cursors preserve the full UTC microsecond timestamp and UUID; use the returned cursor unchanged. It is a pagination boundary, never authorization. Newer terminal games appear on refresh; following older pages does not shift offsets when new results arrive. The list excludes active/paused games, Sandbox and guest records.

History reads use a bounded summary projection; opening a result restores and validates the complete accepted history through the existing details/replay/PGN/invocation endpoints. Neither flow acquires a controller, resumes a game, requests a provider credential, or dispatches inference. Results remain private across sessions and after starting another game. Stockfish and richer cost analysis remain separate work.

History rows offer **Delete game**, and **Clear history** covers terminal games on every page. Separate dialogs explain the scope, initially focus Cancel, and block duplicate submissions. Success clears old list data, resets to the newest page, announces the result and focuses the list heading. Unconfirmed requests retain their dialog and offer explicit retry or Cancel/refresh; a failed refresh after confirmed deletion never restores old rows or claims the games are still saved.

| Route                        | Body                        | Success                 |
| ---------------------------- | --------------------------- | ----------------------- |
| `POST /games/:gameId/delete` | `{ gameId, confirm: true }` | `{ status: "deleted" }` |
| `POST /games/history/clear`  | `{ confirm: true }`         | `{ status: "deleted" }` |

Both require a valid account session and completed profile, exact `WEB_ORIGIN`, and strict body/query validation. Clients send the same expected-account assertion as history reads. Individual path/body UUIDs must match; malformed IDs never become clear requests. Missing, foreign, guest and Sandbox IDs produce the same successful no-op, including when both cookies exist; owned active/paused games return `409 INVALID_GAME_STATE` and must be stopped first. Responses are no-store and contain no deletion counts or private records. An individual repeat is safe; each explicit clear repeat evaluates the terminal set again under the account lock, following the [product boundary](product.md#private-history-and-deletion). No write is automatically retried. Deletion is atomic, uses the existing cascades without a migration, and removes game data from PostgreSQL, not external backups or already-downloaded PGNs. Reads begun before commit may finish consistently with old data; later private reads/replay/export return `404 NOT_FOUND`.

Run `npm run test:e2e -- test/e2e/history.spec.ts` for desktop/mobile history, pagination, confirmation focus, failure/uncertain deletion retries, cleared URL/replay/PGN denial, preserved unfinished games/keys, cross-session results, privacy and expanded-text layout. These tests use real auth/game services and injected provider responses; they make no external provider calls.

## Saved credential API

These account-only endpoints use a valid Better Auth cookie, no-store responses and strict shared contracts. POST requires the exact `WEB_ORIGIN`; unknown body/query fields are rejected. Clients send `X-Neurochess-Expected-Account` with the account ID they resolved so a stale tab cannot manage a different cookie account. Guests never gain access, including when both cookies exist. Profile onboarding is not required for key management.

| Route                      | Body                                                    | Success                     |
| -------------------------- | ------------------------------------------------------- | --------------------------- |
| `POST /credentials`        | `{ credentialId, save: true, provider, label, apiKey }` | `201` metadata              |
| `GET /credentials`         | No query fields                                         | `200 { credentials }`       |
| `POST /credentials/revoke` | `{ credentialId }`                                      | `200 { status: "deleted" }` |
| `POST /credentials/clear`  | `{ confirm: true }`                                     | `200 { status: "deleted" }` |

Generate a fresh UUID `credentialId` for each new save. Reusing an ID within the same account returns `409 CREDENTIAL_CONFLICT` and never overwrites. The same ID in another account does not conflict or reveal that account's record; credential references always require the authenticated owner as well as the ID. If the response is lost, list metadata and reconcile that ID before offering another explicit save. A list without that ID cannot rule out a late commit, so later attempts reuse it until a list or response settles it; a conflict then means an earlier attempt was stored. Never retry with a new ID while the outcome is uncertain. Distinct IDs may save identical keys/labels; no plaintext fingerprint is stored. Each account can save 100 credentials, with `409 CREDENTIAL_LIMIT_REACHED` beyond that limit. Lists are complete within that bound, newest first with ID as a stable tiebreaker. Concurrent saves/clear/revoke serialize per account: clear removes rows existing at its transaction, and a later save survives. Repeating revoke or clear succeeds; absent and foreign revoke IDs are indistinguishable and never delete another account's record.

Metadata contains only `credentialId`, provider, trimmed label (1–64 characters, no controls), `maskedSuffix`, and `createdAt`. The suffix is the final four ASCII letters/digits/underscore/hyphen only for keys longer than eight characters; otherwise it is `null`. A label containing the submitted key is rejected. Provider keys use the existing 1–4096 printable ASCII boundary; saving does not call a provider or establish key validity. There is no individual read or reveal endpoint. Provider discovery/turn requests accept either `apiKey` or `credentialId` as described [below](#ai-provider-and-game-api).

Set both `CREDENTIAL_ENCRYPTION_KEY_ID` and `CREDENTIAL_ENCRYPTION_KEY` to enable saves. Generate the latter with a cryptographic generator as exactly 32 random bytes encoded in canonical base64. Keep it separate from `BETTER_AUTH_SECRET`, outside PostgreSQL/source control, in deployment secret storage. Do not set a `VITE_` equivalent. A partial or malformed pair prevents startup with variable names only; omitting both disables saving with `503 CREDENTIAL_UNAVAILABLE`, while authenticated listing/revocation/clear remain available. No key is generated automatically at startup.

The [envelope and operations ADR](decisions/0014-encrypted-provider-credentials.md) defines the encryption format, key-loss recovery and rotation requirements. Back up the deployment key separately from database backups and test recovery before production. Losing it makes the saved ciphertext unrecoverable; users can delete records and explicitly save replacement provider keys. This implementation accepts one configured key ID/material pair. Do not replace that material under the same ID or switch IDs while rows still need the old key. Production rotation requires a reviewed maintenance procedure: stop writers, retain old secrets, authenticate/decrypt each old envelope and re-encrypt under a new random key and unique ID (with new nonces), verify every row, deploy the new configuration, then restart. Retain old secrets for backup restoration under the deployment's retention policy. An automated rotation/multi-key service is outside this change. Revoking a saved record deletes it from Arena, not from the upstream provider or existing backups.

### Credential UI

Open **Provider keys** at `/account/credentials` to save a labeled key, inspect masked metadata, revoke one key or clear all saved keys. Management is available before username onboarding. Saving requires the unchecked **Save this key to my account** opt-in and explains persistence before submission. Submitted raw values are cleared, including when acknowledgement fails; an uncertain save refreshes metadata and reconciles its ID before another save is offered, and later attempts reuse that ID until it is settled. Revoke/clear dialogs initially focus Cancel and explain the accepted in-flight result policy. Native navigation to settings ends the current match controller; returning to its private URL recovers paused.

Setup and paused recovery default every AI seat to **Use for this tab**. Accounts may explicitly choose a saved key matching that seat's provider. Source/provider changes cancel obsolete discovery and discard its model/capability selections. Metadata refreshes on focus, pageshow, a 15-second interval and payload-free cross-tab notifications; they never select a key. Raw keys, saved selections and private metadata clear on identity changes/pagehide. Missing or rejected keys offer saved selection or session-key replacement, followed by explicit Resume or Next move. Guests retain session-only fields and account-storage guidance.

Run `npm run test:e2e -- test/e2e/credentials.spec.ts` for desktop/mobile source combinations, both human colors, refresh, revocation, unavailable encryption, rejected keys, account switching, privacy and accessible settings. The isolated browser server uses the actual credential service and PostgreSQL with a process-local test encryption key and injected provider transports. These tests make no paid provider calls and do not establish live key validity.

## Sandbox API

Set `NODE_ENV=development` and `SANDBOX_ENABLED=true` in the local `.env`, apply migrations, and start the API. Production configuration rejects enablement; disabled servers also reject access to already-persisted sandbox games. The [web sandbox](#sandbox-ui) uses these endpoints unchanged.

| Endpoint                        | Request                                                        | Success                                            |
| ------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `POST /guest-session`           | `{}`                                                           | `200 { "status": "ready" }` plus guest cookie      |
| `POST /sandbox/games`           | `{}`                                                           | `201` standard-position active snapshot, version 0 |
| `GET /sandbox/games/unfinished` | No query fields                                                | `200 { snapshot }`, unfinished Sandbox or `null`   |
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

## AI provider and game API

These routes accept an authenticated account session or an explicitly bootstrapped guest, with exact-Origin POST checks, private ownership, strict schemas, and `Cache-Control: no-store`. A valid account takes precedence when both cookies exist; it gains no access to ordinary guest games. Keys are accepted only in discovery and turn JSON bodies. Use HTTPS outside localhost development. The public Arena at `/` uses these boundaries for both AI modes. Provider registration is explicit in `apps/api/src/server.ts`; tests inject mocked upstream transport without paid calls.

Account integrations must send `X-Neurochess-Identity: account` on every game/provider read and command, including discovery and creation. This requires sign-in even when the browser has removed an expired cookie. Without that header, an invalid/expired account cookie still returns `401`; an explicit `X-Neurochess-Identity: guest` permits guest access only if there is no valid account session. Missing guest identity still requires explicit bootstrap. Invalid header values return `400`. Sandbox creation/discovery and stored Sandbox IDs on shared routes always use the original guest cookie, even with an account cookie present.

An account shares one unfinished public game across sessions/devices. Discover/read it, issue versioned Pause without a controller UUID to recover, then re-enter keys and explicitly claim a controller before Resume or Next move. Reads and sign-in never start or pause games. Sign-out/revocation fences that session's commands, retries, heartbeats, and late provider results; expired presence pauses the game even when no account sessions remain. Terminal account games retain private URL-based replay and PGN access after another game starts. Account UI and history-list delivery are tracked in the [roadmap](roadmap.md#phase-3--accounts-encrypted-credentials-and-history).

| Endpoint                         | Request                                                                                                                       | Success                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `POST /providers/models`         | `{ provider, apiKey }` or `{ provider, credentialId }`                                                                        | `200 { ok: true, models }` or `{ ok: false, error }`          |
| `POST /games`                    | Strict `{ mode, seats: { white, black } }` AI configuration, no keys                                                          | `201 { snapshot, configuration }`                             |
| `GET /games/unfinished`          | No query fields                                                                                                               | `200 { game }`, private details or `null`                     |
| `GET /games/:gameId/details`     | UUID, no query fields                                                                                                         | `200 { snapshot, configuration }`                             |
| `GET /games/:gameId/invocations` | UUID, no query fields                                                                                                         | `200 { gameId, version, turns }`                              |
| `POST /games/:gameId/ai-turn`    | `{ gameId, expectedVersion, commandId, controllerId, step?, apiKey }` or the same body with `credentialId` replacing `apiKey` | `200` authoritative snapshot, including provider-error pauses |

Ordinary AI games reuse the existing snapshot, human-move, lifecycle, replay, and PGN routes; owning a game does not authorize a human move on an AI seat. A turn's provider/model/settings always come from persisted seat configuration. Exactly one credential source is required: a printable `apiKey` or an account-owned UUID `credentialId`; both/neither, unknown fields and malformed references return `400`. The same source is used for fresh discovery and inference, but saved credentials are resolved again for each operation/retry and checked between catalog pages. References are scoped to the authenticated owner and matching provider before decryption. Guests cannot resolve saved references. Missing, foreign, revoked, undecryptable (including missing encryption configuration), or provider-rejected credentials return safe `provider_auth` discovery failures or authoritative paused turn snapshots with normalized failure telemetry. These failures do not consume the invalid-output budget; explicit continuation may supply a different saved reference or session key. Credentials and references never enter configuration, receipts, reservations, snapshots or invocations. See the [revocation policy](product.md#saved-credential-use-and-revocation) for already-dispatched work. Invocation reads expose normalized provider failure codes for localization; discovery returns the same safe codes without upstream prose. Empty catalogs are successful discovery results.

`409` AI errors include `AI_TURN_IN_PROGRESS`, `AI_TURN_RECOVERY_REQUIRED`, `AI_TURN_CANCELLED`, and `AI_ADAPTER_UNAVAILABLE`. `422 AI_PARAMETERS_INVALID` means the game was paused because an advertised range or enumeration no longer accepts the saved settings; no inference attempt was dispatched. AI-specific errors contain only `code` and `requestId`. Ordinary game errors retain their existing envelopes. Missing or ambiguous credential sources fail strict body validation before dispatch. Reads never pause or resume a game.

See the [AI turn transport policy](architecture.md#ai-turns) for cancellation, deadlines, and uncertain outcomes, and the [provider boundary](architecture.md#ai-provider-boundary) for capability filtering. The page-memory client modules are intentionally separate from the Sandbox controller. Their owner must cancel outstanding requests, clear credentials on access loss, and perform explicit paused recovery before enabling continuation controls.

### Arena controller API

`POST /games/:gameId/controller` accepts either `{ gameId, controllerId, action: "acquire", expectedVersion }` or `{ gameId, controllerId, action: "heartbeat" }` and returns the current authorized snapshot. It requires the same cookie, exact Origin, strict schema, and no-store protections as other commands. Claims and heartbeats carry no provider keys. `AI_CONTROLLER_BUSY` identifies another live controller; `AI_CONTROLLER_LOST` requires explicit paused recovery. Ordinary AI Resume requires a live `controllerId` on its lifecycle command. Recovery Pause omits that field to revoke any previous controller; it is valid even while already paused and advances the revision to fence uncertain steps.

The Arena mounts mode selection and setup at `/`. Start acquires control and requests one AI move at a time, waiting for commands on human turns; `/?game=<uuid>` restores configuration and full history through private reads, then pauses explicitly. Re-enter missing AI-seat keys before Resume or Next move. Next move sends `step: true` to the turn route and is available only on an AI turn; speed selects the delay between acknowledged moves and the next AI request. Stop requires confirmation and persists `aborted`; AI-versus-human also offers confirmed resignation for the human's color, including paused/off-turn positions. Completed/stopped games reuse private replay and PGN. Ordinary creation conflicts and `/games/unfinished` exclude Sandbox. Explicitly opening a Sandbox game ID on the Arena route offers a link to `/sandbox?game=<uuid>` only when that development flow is enabled.

Presence timing and restart/competing-tab behavior are defined in [ADR-0011](decisions/0011-ai-controller-presence-and-step.md). Session-only keys disappear on refresh, close, and navigation; recovering an uncertain provider call does not guarantee that the first request was unbilled.

### OpenAI adapter

OpenAI uses authenticated `GET /v1/models` discovery and `POST /v1/responses` inference at the fixed HTTPS API origin. Requests carry the server's standard instructions and fair chess context, with `store: false` and `background: false`; no tools, conversation IDs, prior responses, or reasoning history are sent. Native fetch performs one request per adapter operation with redirects disabled, the caller's abort signal, and no application retries. The shared runner alone retries invalid model output. Response bodies are limited to 4 MiB and consumed fields receive runtime validation; raw errors, request IDs, reasoning, and unused metadata are discarded.

The [Models API](https://developers.openai.com/api/reference/resources/models/methods/list) returns a complete, unpaginated account catalog without parameter capabilities. `openai-capabilities.ts` annotates live IDs using documented profiles for [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o), [GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini), [GPT-5](https://developers.openai.com/api/docs/models/gpt-5), [GPT-5.6](https://developers.openai.com/api/docs/models/gpt-5.6-sol), and [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), including only the variants/snapshots explicitly matched in that file. This is a capability annotation, not a catalog allowlist: unfamiliar IDs and fine-tunes remain listed as unknown and may be attempted with no optional parameters. Known non-text endpoint families are marked unsupported. Temperature is exposed only for the matched non-reasoning profiles; conditional sampling controls on reasoning models remain disabled because the shared descriptor cannot express parameter dependencies. Output limits include reasoning tokens.

The [Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create) defines text extraction, incomplete/refusal outcomes, and usage. Only assistant `output_text` content is parsed as the canonical move JSON; refusal and output truncation count as invalid model output. Malformed envelopes/usage pause as `provider_unavailable/invalid_response`. [HTTP authentication, quota/rate-limit, and upstream errors](https://developers.openai.com/api/docs/guides/error-codes) follow the common pause policy. Missing usage/counts stay null, including a missing total; counts are never inferred or summed. Optional commentary containing a credential echo or NUL is omitted without rejecting the move.

Adapter tests run `apps/api/test/providers/adapter-contract.ts` through deterministic HTTP fixtures, with provider-specific cases alongside it and PostgreSQL orchestration in `apps/api/test/openai.integration.test.ts`. Future adapters reuse that contract suite with their own wire fixtures. Live calls require separate authorization; mocked coverage does not establish current account access, availability, or model response quality.

### Anthropic adapter

Anthropic uses the fixed `https://api.anthropic.com` origin with request-scoped `x-api-key` and `anthropic-version: 2023-06-01` headers. [Model discovery](https://platform.claude.com/docs/en/api/models/list) follows validated `after_id` cursors, rejecting duplicate IDs, inconsistent cursors, partial failures, credential echoes, and catalogs exceeding 10,000 models or 100 pages. The live `max_tokens` and `capabilities.effort` fields supply output limits and supported effort values; unfamiliar IDs are retained. Missing metadata leaves controls unknown. Temperature is omitted: discovery does not advertise sampling support, and the [Messages API](https://platform.claude.com/docs/en/api/messages/create) deprecates it on newer models.

Messages requests contain the common system instruction and one user message with the fair chess context. Supported effort maps to `output_config.effort`; no thinking configuration, tools, prompt caching, or previous assistant content is sent. The required `max_tokens` defaults to 1,024, capped by a smaller discovered maximum. The adapter's pure parameter resolver supplies this default before invocation persistence, including for unknown models, so records match the wire request. Discovered capabilities travel only within the current turn request. HTTP calls use native fetch without retries or redirects, honor cancellation, and bound response bodies to 4 MiB.

Only text blocks become move JSON; thinking, signatures, request IDs, and unused metadata are discarded. [Refusal and output/context truncation](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) are invalid model output. Unexpected tool/continuation stops and malformed envelopes or usage are provider failures. Usage preserves reported `input_tokens` and `output_tokens`, with missing counts null and no synthesized total or cache-token sum. [Authentication, billing/rate-limit, timeout, and upstream errors](https://platform.claude.com/docs/en/api/errors) follow the common pause policy. Ambiguous `400 invalid_request_error` responses, including spend-limit errors without a distinct type, become `provider_unavailable/upstream`; raw error prose is never used or returned.

`apps/api/test/providers/anthropic.test.ts` runs the same HTTP adapter contract with paginated fixtures; `apps/api/test/anthropic.integration.test.ts` verifies real orchestration and persistence with mocked transport. No live-provider availability or response-quality claim follows from these tests.

### Google adapter

Google uses the fixed `https://generativelanguage.googleapis.com/v1beta` origin with request-scoped `x-goog-api-key` headers. [Model discovery](https://ai.google.dev/api/models) follows bounded, encoded `pageToken` cursors, rejecting duplicate IDs, cursor cycles, credential echoes, partial failures, and catalogs exceeding 10,000 models or 100 pages. Discovery strips the `models/` resource prefix from configuration IDs and restores it only in generation URLs. `supportedGenerationMethods` determines whether `generateContent` is available; absent metadata stays unknown. Live `maxTemperature` and `outputTokenLimit` supply optional parameter bounds. Discovery does not advertise thinking levels, so reasoning-effort controls remain unavailable. No model allowlist is used.

[GenerateContent](https://ai.google.dev/api/generate-content) receives the common system instruction and one user content containing the fair chess context. Only advertised temperature and output-limit selections enter `generationConfig`; omitted settings use provider defaults. Requests set `store: false` and omit tools, cached context, and thinking controls. Native fetch honors cancellation, disables redirects, bounds bodies to 4 MiB, and performs no application retries. The runner owns invalid-output retries and chess legality.

The adapter expects one candidate and parses only visible text, discarding thoughts, signatures, identifiers, and unused metadata. Blocking is a refusal; output truncation and malformed model JSON follow the common invalid-output policy. Unknown finish reasons, malformed envelopes, and malformed usage pause as provider failures. Usage maps reported prompt, candidate, and total counts independently; the total may include thinking tokens and is never recomputed. Missing counts stay null.

[Google's GenerateContent errors](https://ai.google.dev/gemini-api/docs/generate-content/api-errors) map to the common pause policy. Structured `API_KEY_INVALID` details distinguish invalid-key HTTP 400 responses from other invalid requests. Ambiguous `INVALID_ARGUMENT` and `FAILED_PRECONDITION` errors remain `provider_unavailable/upstream`; raw error prose never determines classification. Generation-only 404/501 failures identify unavailable models/methods.

`apps/api/test/providers/google.test.ts` runs the shared HTTP adapter contract; `apps/api/test/google.integration.test.ts` covers protected routes, real PostgreSQL orchestration, persisted parameters, retry/recovery, cancellation, and redaction using mocked transport. These tests do not establish live account access or response quality.

### OpenRouter adapter

OpenRouter uses the fixed `https://openrouter.ai/api/v1` origin with request-scoped Bearer authentication. [Account-filtered model discovery](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails) pages through `/models/user` using locally computed offsets, never following upstream links. Catalogs are bounded to 10,000 models and 100 pages; duplicate IDs, inconsistent totals, malformed metadata, and credential echoes fail without returning partial results. Routed model IDs and variant suffixes are preserved without a model allowlist. Text input/output modalities determine move support; advertised `temperature`, `max_tokens`, and `reasoning` support enables the corresponding controls. Output bounds come from `top_provider.max_completion_tokens`. [Reasoning effort choices](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#discovering-per-model-reasoning-options) come from `reasoning.supported_efforts`: absence leaves the control unavailable, explicit null permits the documented gateway efforts, and mandatory reasoning excludes `none`.

[Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) receives one system instruction and one user message with the complete fair chess context. Only supported selections are sent as `temperature`, `max_tokens`, and `reasoning.effort`; omitted settings use provider defaults. [Routing](https://openrouter.ai/docs/guides/routing/provider-selection) requires parameter support and disables provider fallbacks. [Context compression](https://openrouter.ai/docs/guides/features/message-transforms) is explicitly disabled so history cannot be silently shortened. Native fetch performs no retries, disables redirects, honors cancellation, and bounds response bodies to 4 MiB. Only visible assistant text becomes move JSON; reasoning, router/upstream identifiers, pricing, and unused metadata are discarded. [Reported usage](https://openrouter.ai/docs/cookbook/administration/usage-accounting) is normalized without extra requests or inferred counts, including validated usage on error envelopes. Missing usage remains null.

[Errors](https://openrouter.ai/docs/api_reference/errors-and-debugging) are checked even under HTTP 200 and take precedence over choices. Typed model refusals and generation truncation follow the invalid-output policy; external content filters, ambiguous 403s, and request/context errors pause as upstream failures. Router credential rejection maps to `provider_auth`; identified upstream authentication failures map to `provider_unavailable/upstream`, avoiding a misleading invalid-OpenRouter-key diagnosis. Typed quota and timeout errors retain their categories even when wrapped in another HTTP status. Raw error prose and nested provider payloads never determine classification or leave the adapter.

`apps/api/test/providers/openrouter.test.ts` runs the shared HTTP adapter contract. `apps/api/test/openrouter.integration.test.ts` covers authorized discovery/turns, parameter persistence, retries, routed quota recovery, cancellation, late responses, and redaction through real PostgreSQL orchestration with mocked transport. These tests do not establish live provider availability, billing behavior, or response quality.

## Unit test environments

`npm run test:unit` runs both projects in `vitest.config.ts`. Select one with
`npm run test:unit -- --project=node` or `npm run test:unit -- --project=web`.
The `node` project includes API, package, web build, and explicitly audited
DOM-independent frontend tests; it does not load the web DOM setup. The `web`
project uses jsdom and `apps/web/src/test/setup.ts` for the remaining frontend tests,
including components, hooks, navigation, and page-memory credentials.

Keep `webNodeTestFiles` as the shared inclusion/exclusion allowlist. When splitting
a listed test such as `game/controller.commands.test.ts`, audit each resulting file's imports
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

## Browser tests

The isolated browser-test server also serves `/__test__/setup`, mounting the Arena setup adapter with injected discovery fixtures and the real guest/game API and disposable database. This isolated entry stops at a creation/return handoff; the public `/` entry exercises the complete match controller using the same test-only provider fixtures. Run `npm run test:e2e -- test/e2e/ai-setup.spec.ts` for setup behavior and layout checks. For interactive review, run `node --conditions=development --import tsx test/e2e/server.ts` and open `http://localhost:5174/__test__/setup`; use non-secret placeholder keys only. `rejected-fixture` and `empty-fixture` exercise discovery error/empty states. Stop this server before running Playwright, which owns the same ports. This test entry and all provider fixtures are absent from normal Vite servers and production bundles.

On that disposable test server, `/` plays Fool's Mate with ordinary placeholder keys. `slow-fixture` delays inference, `quota-fixture` produces a provider pause, and `invalid-fixture` exhausts the three-invalid-output budget. These injected fixtures never call an external provider. Run `npm run test:e2e -- test/e2e/ai-match.spec.ts` for public controls, controller loss, competing tabs, uncertain acknowledgements, refresh/key recovery, private replay, and responsive layout.

The competing-tab/between-call absence and heartbeat-loss scenarios carry `@controller-protocol` and run only in `desktop`; `mobile-touch` excludes that tag at collection. Run just those scenarios with `npm run test:e2e -- --project=desktop --grep=@controller-protocol`. Other match recovery, focus, and interaction scenarios continue to run in both projects.

Run `npm run test:e2e -- test/e2e/ai-human.spec.ts` for either human color, AI-first play, promotion, duplicate/uncertain human commands, provider retry, single-key recovery, resignation, and natural completion. `promotion-fixture` supplies a legal promotion approach from the standard position in this isolated server only.

Run `npm run test:e2e -- test/e2e/ai-telemetry.spec.ts` for replay-linked commentary/usage, retry Events, incomplete operational totals, and detail-read recovery. `telemetry-fixture` supplies two initial invalid outputs followed by legal moves, literal markup commentary, and mixed reported/missing usage. `retry-fixture` supplies an invalid output followed by a quota pause; replacing it with an ordinary placeholder key permits explicit retry. These are test-server fixtures only. The provider matrix in `apps/api/test/provider-matrix.integration.test.ts` instead exercises all four real adapters through injected HTTP responses, the API, and PostgreSQL. Neither suite establishes current live-provider availability.

After installing dependencies, prepare Chromium and the disposable database:

```text
npm exec playwright -- install chromium
npm run infra:test:up
npm run verify
npm run test:e2e
```

Playwright global setup forks the actual Fastify guest/game services and Vite app at `http://localhost:3101` and `http://localhost:5174`, plus a Sandbox-disabled web app at `http://localhost:5175`, and waits for IPC readiness. These ports must be free; the suite refuses to reuse existing servers. The test entrypoint validates `TEST_DATABASE_URL` with the same `_test`/no-options guard as integration tests before opening a connection or applying reviewed migrations. It never falls back to `DATABASE_URL`. Games use the real API and legal moves from the standard position. Transport-fault cases replace acknowledgements before or after execution; authoritative reads and explicit retries still use the real service.

Desktop Chromium and a Chromium mobile-touch context create a game, play part of Fool's Mate, refresh into paused recovery, explicitly resume, complete checkmate, navigate every replay position, copy/download PGN, start another game, and reopen the previous private URL. Downloaded text must exactly equal persisted PGN; clipboard readback normalizes Windows CRLF conversion while the client writes the canonical text unchanged. Further cases cover both resignation colors, neutral abortion, isolated-guest access denial, Sandbox-entry recovery, private game URLs, enabled/disabled navigation, and White knight/Black rook underpromotions through legal moves from the standard position.

Accessibility and layout checks cover keyboard directions, castling, en passant and Tab order, modal focus containment/return, readable control labels, 44px controls, reduced motion, stable move-history placement during commands, and axe checks. Entry, live, recovery, and replay use the concept positions at 320/390/768/1024/1440px, also with 200% text and 50% expanded test resources; promotion choices remain reachable with enlarged text at every width. Expansion is injected by the test into the dev module; it is not a product locale or flag. Uncertain move, pause, and recovery commands verify locked controls and identical explicit retries; committed and conflicting moves verify complete snapshot adoption without duplicate submission.

In `arena-states.spec.ts`, entry/live/recovery geometry runs at 1024/1440px in `desktop` and 320/390/768/1024px in `mobile-touch`, with both text sizes in each assigned width. The shared 1024px boundary retains coverage with both device settings. State transitions, focus, touch, and axe checks still run at each project's default viewport. Replay and `ai-setup.spec.ts` retain the full width/text matrix in both projects because native scrollbar gutters change their geometry. The separate telemetry and move-history specs retain their additional layout boundaries, including 1025px.

Each browser context has an isolated guest. Per-test cleanup deletes guests/games associated with captured game creations. The server tracks every guest it creates, including guests without games and additional browser contexts. Global teardown sends an IPC shutdown command and requires both cleanup acknowledgement and a zero process exit, including after failed tests. Cleanup attempts every server, scoped database deletion, and pool closure even if an earlier step fails. A shutdown timeout forces termination and fails the run; successful cleanup never depends on Windows signal support. Manual server runs retain `SIGINT`/`SIGTERM` shutdown handlers. `npm test` also checks this lifecycle against real child processes and the disposable database, so ports 3101, 5174, and 5175 must be free for integration tests too.

Screenshots and failure context go to `neurochess-playwright-results` in the OS temporary directory, outside the repository. Traces, HARs, and videos are disabled so guest cookie headers are not recorded.

CI runs on pull requests and pushes to `master`. The `checks` job runs Compose and migration checks, `npm run verify`, and the built-service startup check `npm run smoke`. In parallel, the `e2e` matrix runs `desktop` and `mobile-touch` on separate runners, each with its own PostgreSQL service, shared-package build, Chromium installation, and one Playwright worker. All jobs retain a 15-minute timeout. The final `verify` check runs even when a dependency fails, is cancelled, or is skipped, and passes only when both `checks` and the entire E2E matrix succeed.

Automated checks do not certify screen-reader behavior or every browser engine. Consult the [current validation limits](design-system/validation.md) for remaining coverage gaps. Report each run in the change summary, PR, or CI; update that document only when a gap changes.

## Migrations

Migration `0014_account_history_index.sql` adds a partial account/terminal-timestamp/UUID index for private history, without rewriting rows. Stop API writers while applying the forward migration and restart afterward; ordinary index creation can block writes on a populated database. The migration test upgrades populated prior schemas and checks that all application/authentication rows remain unchanged.

Schema definitions live under `packages/database/src/schema`. Generate SQL with Drizzle Kit, inspect the generated SQL and metadata, and commit both. Apply migrations explicitly; the API does not mutate the schema during startup.

Migration `0013_owner_scoped_credential_ids.sql` replaces global credential-ID uniqueness with the composite `(user_id, id)` primary key. It preserves all IDs, ownership, metadata and encrypted envelopes without re-encryption. Stop every API writer, apply the reviewed forward migration, then restart only the updated API: old writers use `ON CONFLICT (id)`, which is incompatible with the new key. Keep `0012` unchanged. Populated-schema tests preserve existing data and decrypt a migrated credential; independent accounts can then use the same ID while same-account duplicates remain rejected.

Migration `0012_provider_credentials.sql` adds the account-owned credential table, owner/creation index, bounded envelope checks and owner cascade; it does not rewrite existing auth/profile/game data. Stop API writers, apply the reviewed migration, configure the optional encryption pair, then restart the updated API. Populated-schema tests compare all prior records before/after this migration; fresh/repeated migrations run in integration setup. The built-in account deletion path remains disabled pending complete application cleanup.

Migration `0011_profiles.sql` adds a private profile row keyed to the auth user, nullable display/normalized username, sticky avatar-removal preference, validation check and unique normalized-name index. It leaves populated auth/game tables and existing provider images unchanged, and never infers usernames. Existing accounts must complete onboarding before account game/provider access, including recovery. Stop all API writers, apply the reviewed migration, and restart the updated API together; old binaries bypass the new onboarding requirement. Guest/Sandbox access and server-side controller cleanup remain available. Populated-schema tests preserve account owners, human seats, guest games and execution records; fresh/repeated migration runs are part of integration setup.

Migration `0010_account_owned_games.sql` adds nullable account owner/participant foreign keys, exactly-one-owner and guest-only Sandbox checks, exclusive human-seat identities, and a partial unique unfinished-account index. It preserves every existing guest owner/seat and game execution record; no ownership is transferred. Stop API writers, apply it, and restart the updated API together. Old binaries must not read account games because they assume non-null guest ownership. Integration tests upgrade populated legacy game/auth tables and retain moves, receipts, reservations, controllers, logical turns, and invocation attempts. User deletion remains restricted until the separate account cleanup lifecycle exists.

Migration `0009_oauth_account_identity.sql` adds a unique `(provider_id, account_id)` index, preventing one provider identity from acquiring multiple owners. It does not rewrite accounts, sessions, verification records, or games. Stop API writers, apply it, and restart before enabling OAuth. Duplicate bindings fail migration instead of being silently merged; investigate them before retrying. Retain this Arena-specific index after regenerating the library schema. Integration tests upgrade populated pre-OAuth auth/game tables and exercise duplicate-binding rejection.

Migration `0008_better_auth_foundation.sql` adds generated Better Auth user/account/session/verification and rate-limit tables, with auth foreign keys and indexes; it does not rewrite guest identities or games. Stop API writers, apply the reviewed migration, configure the auth origin/secret, and restart the updated API. Integration coverage upgrades populated legacy game schemas and verifies guest ownership, seats, moves, receipts, reservations, and controller records remain intact.

Migration `0007_separate_sandbox_game_slot.sql` replaces the unfinished-owner index with a unique `(owner_guest_session_id, is_sandbox)` index for active/paused games. It does not rewrite game data. Stop old API writers, apply it, and restart the updated API so creation and discovery consistently use their own group. See [ADR-0012](decisions/0012-independent-sandbox-game-slot.md) for the contract and rollback constraint.

Migration `0006_ai_controller_presence.sql` adds the per-game controller UUID/expiry table and cascading foreign key. It does not rewrite existing games or Sandbox data. Stop old API writers, apply it, and restart the updated API; active ordinary AI games without a lease are then paused by the presence worker. Never expire a reservation into another provider dispatch. The [controller ADR](decisions/0011-ai-controller-presence-and-step.md) defines recovery and deployment behavior.

Never edit an applied migration or use schema push as a substitute for reviewed SQL. Better Auth schema generation feeds this same migration history.

Migration `0002_game_command_receipts.sql` creates the shared accepted-command receipts and backfills existing moves. Stop old API writers before applying it, then start the API version that writes receipts for every move and lifecycle action. See [ADR-0007](decisions/0007-lifecycle-recovery-and-private-replay.md). Integration tests exercise this backfill on a populated prior schema, receipt uniqueness, cascading deletion, and atomic rollback.

Migration `0003_ai_game_configuration.sql` adds nullable ordinary AI mode and participant configuration columns with strict field constraints. Existing human-seat games, including Sandbox in every lifecycle state, receive null configuration fields; their marker, assignments, history, receipts, and owner index remain unchanged. It neither infers providers nor grants Sandbox authority. Unsupported pre-existing AI fixture rows without configuration fail the migration instead of receiving invented settings; recreate those disposable fixtures with explicit provider/model/parameters. Stop API writers, apply the forward migration, and restart the updated API before creating AI records through the service. Old APIs do not validate AI configuration and must not serve those records. Ordinary AI HTTP creation and provider operations remain outside the Sandbox API surface.

Migration `0004_ai_turn_reservations.sql` adds a separate execution-reservation table without modifying existing game data. Stop old API writers, apply the migration, and restart the updated API before enabling AI execution; all ordinary-game writers must invalidate reservations with accepted revisions. Do not delete or expire orphaned reservations to retry inference. Recover through the owner-authorized Pause/Resume path in [ADR-0009](decisions/0009-ai-turn-reservations.md). Integration tests kill a separate executor process and verify recovery, late-result fencing, write rollback, and lost-acknowledgement deduplication using only injected adapters and the disposable database.

Migration `0005_ai_invocation_policy.sql` adds logical AI turns and normalized invocation attempts plus the internal `technical_loss` receipt kind. Stop API writers, apply the generated migration, and restart the updated API before dispatching AI turns. Existing Sandbox/AI records and reservations remain unchanged; historical invocations are not backfilled with invented measurements. Existing uncertain reservations still require explicit Pause/Resume recovery. See [ADR-0010](decisions/0010-ai-failure-policy-and-invocations.md) for retry budgets, interrupted attempts, and atomic outcomes. The private `GameService.invocations` read returns safe attempt data; provider failures return an authoritative paused snapshot from `aiTurn`. The [AI HTTP routes](#ai-provider-and-game-api) expose these contracts without another migration.

## Logging and errors

The API logger omits request bodies, retains only method/path/request ID for requests, strips URL queries, masks unknown auth paths that may contain protocol tokens, and recursively redacts credential-like object fields. Raw exceptions are reduced to a safe name and non-secret code before serialization; the error serializer preserves only those diagnostic fields when it receives an already-sanitized record. Better Auth's console logger and telemetry are disabled; auth errors emit fixed application diagnostics without raw library errors.

Idle PostgreSQL pool errors write a fixed, credential-free diagnostic to stderr without terminating the API. The pool remains available for new connections, and `/ready` checks current database availability on every request, returning `503` when its query fails.

System errors retain `code`, `message`, and `requestId`. Structured game errors use the same envelope with enumerated codes; only `GAME_CONFLICT` additionally requires an already-authorized `currentSnapshot`. Messages come from the API's English error catalog, never domain/engine exceptions. Domain failures expose codes and, for an invalid history entry, its one-based ply only. No error accepts arbitrary details or raw exception payloads. Guest/game responses are `no-store`, and the raw guest token appears only in its cookie. Corrupted persisted history or projections yield a safe `500` and leave game data unchanged. Add logging and error tests whenever a new boundary accepts credentials or provider payloads.
