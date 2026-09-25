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

Generate a private auth secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and set `BETTER_AUTH_SECRET` in `.env`. Keep it stable across restarts and shared by API instances; replacing it invalidates signed account cookies. Store the production value in deployment secret storage. It is separate from the later provider-credential encryption key.

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

| Variable                                   | Consumer            | Purpose                                                                                                |
| ------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                 | API                 | `development`, `test`, or `production`                                                                 |
| `API_HOST`                                 | API                 | Fastify listen address                                                                                 |
| `API_PORT`                                 | API                 | Fastify listen port                                                                                    |
| `WEB_ORIGIN`                               | API                 | Exact browser origin allowed by CORS                                                                   |
| `BETTER_AUTH_URL`                          | API, auth generator | Exact public API origin; auth uses the fixed `/api/auth` path                                          |
| `BETTER_AUTH_SECRET`                       | API, auth generator | Required private random secret, 32–256 characters; no default                                          |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | API, auth generator | Optional paired Google OAuth web-client credentials; omit both to disable                              |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | API, auth generator | Optional paired GitHub OAuth App credentials; omit both to disable                                     |
| `AUTH_EMAIL_TRANSPORT`                     | API, auth generator | `disabled` (development/test default) or `smtp`; production requires `smtp`                            |
| `AUTH_EMAIL_FROM`                          | API                 | Single sender email address, required for SMTP                                                         |
| `SMTP_HOST`, `SMTP_PORT`                   | API                 | SMTP host without a scheme/credentials; port defaults to 587                                           |
| `SMTP_SECURITY`                            | API                 | `starttls` (required upgrade, default), `tls` (implicit TLS), or loopback-only development/test `none` |
| `SMTP_USER`, `SMTP_PASSWORD`               | API                 | Optional SMTP credentials; supply both or neither                                                      |
| `DATABASE_URL`                             | API, tools          | PostgreSQL connection URL                                                                              |
| `LOG_LEVEL`                                | API                 | Pino log level                                                                                         |
| `SANDBOX_ENABLED`                          | API, web            | Exactly `true` or `false`; defaults to false; production API rejects true                              |
| `GUEST_SESSION_TTL_SECONDS`                | API                 | Inactivity expiry, 1–31536000 seconds; defaults to 86400                                               |
| `VITE_API_BASE_URL`                        | web                 | Public HTTP(S) API origin, without credentials, paths, query, or fragment                              |
| `POSTGRES_*`                               | Compose             | Local database name, user, password, and port                                                          |
| `TEST_DATABASE_URL`                        | Tests               | Explicit disposable PostgreSQL database ending in `_test`; no fallback                                 |
| `TEST_POSTGRES_PORT`                       | Compose             | Separate test-service port, defaults to 5433                                                           |

Invalid environment errors contain variable names only. Never add server secrets to a `VITE_` variable.

`WEB_ORIGIN` and `BETTER_AUTH_URL` accept exact HTTPS origins without credentials, wildcards, paths, trailing slashes, queries, or fragments. Development/test also allow `http://localhost` with an optional port; production requires HTTPS. Use a same-site web/API deployment for the Lax account cookie. Cross-site third-party cookies and client-supplied forwarding headers are unsupported. Fastify proxy trust stays disabled pending deployment configuration.

Vite explicitly exposes only `SANDBOX_ENABLED` in addition to the public `VITE_` variables. Both applications read the same root `.env`; no second Sandbox flag is needed. Restart development services after changing it, or rebuild the web bundle and restart the API when using `npm start`. The web value is fixed at Vite startup/build time; API checks still apply if the configurations differ.

## Root commands

| Command                      | Purpose                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `npm run dev`                | Build shared packages, watch them, and run both applications       |
| `npm run build`              | Build shared packages, the API, and the Vite production bundle     |
| `npm start`                  | Run the built API and web preview                                  |
| `npm run lint`               | Run ESLint with zero warnings                                      |
| `npm run typecheck`          | Type-check project references and tests                            |
| `npm test`                   | Run unit, PostgreSQL integration, and dependency-boundary checks   |
| `npm run test:unit`          | Run database-free unit tests                                       |
| `npm run test:integration`   | Run required PostgreSQL-backed tests; fail if unavailable          |
| `npm run test:e2e`           | Run desktop/mobile browser gameplay and accessibility checks       |
| `npm run format:check`       | Verify Prettier formatting                                         |
| `npm run verify`             | Run formatting, lint, types, tests, and build                      |
| `npm run smoke`              | Start and probe both built services                                |
| `npm run infra:up`           | Start and health-check PostgreSQL                                  |
| `npm run infra:test:up`      | Start the isolated disposable test PostgreSQL service              |
| `npm run infra:down`         | Stop PostgreSQL while preserving data                              |
| `npm run db:generate -- ...` | Generate a named Drizzle migration                                 |
| `npm run db:check`           | Check migration metadata for consistency                           |
| `npm run db:migrate`         | Apply pending migrations                                           |
| `npm run db:studio`          | Open Drizzle Studio                                                |
| `npm run auth:generate`      | Regenerate Better Auth's Drizzle schema from the API configuration |

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

Better Auth, its Drizzle adapter, and the `auth` generator are pinned together at 1.7.5. They use stable Drizzle ORM 0.45.3 and Kit 0.31.11. The generator reads `apps/api/auth.config.ts`, which uses the same factory as the server. [Better Auth's Drizzle integration](https://better-auth.com/docs/adapters/drizzle) generates schema only; Drizzle Kit owns SQL migration generation/application.

| Endpoint                    | Request                        | Success                                                                                 |
| --------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `GET /api/auth/get-session` | No query fields                | `{ session: null }` or `{ session: { user: { id, email, emailVerified }, expiresAt } }` |
| `POST /api/auth/sign-out`   | `{}`, JSON, exact `WEB_ORIGIN` | `{ success: true }` and separate cookie-clearing headers                                |

Use credentialed requests. The host-only `__Secure-neurochess.session_token` cookie is Secure, HttpOnly, SameSite=Lax, and scoped to `/`. Only cookies carry the session token; application JSON never includes it. Sessions use PostgreSQL on every lookup, last seven days, and refresh after one day. They are fresh for sensitive operations for one hour. Sign-out revokes the current session; other sessions remain valid. A failed revocation returns a safe error and preserves the browser cookie for retry. Errors use the English catalog with `AUTH_*` codes, `message`, and `requestId`; the browser should localize the code rather than display library messages.

These session endpoints remain available with email delivery disabled. Configuring SMTP enables the email lifecycle below; each configured OAuth credential pair independently enables that provider. Profiles use the private application endpoints below; Better Auth's generic user-update endpoint and account deletion remain closed. Public game APIs support account ownership as described below; Sandbox keeps its guest authority. Browser authentication, profile onboarding, and identity-transition UI remain separate roadmap deliverables. Test-only factories create session fixtures directly; lifecycle integration tests exercise the real verified flow against disposable PostgreSQL with an isolated mailbox.

The auth limiter uses process memory: 60 session reads/minute/IP, 10 sign-outs/minute/IP, and the email limits below. A `429` includes `Retry-After`. It is enabled in all environments, resets on restart, and does not coordinate across processes. It uses Fastify's client IP, overwriting the internal IP header; do not enable broad proxy trust to obtain forwarded addresses. Before exposing more endpoints, add their protections and contract tests.

### Email lifecycle API and delivery

All endpoints below require JSON, an exact `Origin: WEB_ORIGIN`, and no query fields. Their success response is `{ status: true }`; only sign-in sets a session cookie. The shared contracts reject extra fields, including user IDs, verification flags, names/avatars, and callback/redirect URLs. Email addresses are normalized to lowercase. Passwords follow the [product policy](product.md#email-account-lifecycle). Better Auth's required name starts empty; the public username is chosen through the private profile API.

| POST endpoint under `/api/auth` | JSON body                | Limit per minute/IP                                 |
| ------------------------------- | ------------------------ | --------------------------------------------------- |
| `/sign-up/email`                | `{ email, password }`    | 5; verification delivery also uses the resend limit |
| `/send-verification-email`      | `{ email }`              | 3                                                   |
| `/verify-email`                 | `{ token }`              | 20                                                  |
| `/sign-in/email`                | `{ email, password }`    | 10                                                  |
| `/request-password-reset`       | `{ email }`              | 3                                                   |
| `/reset-password`               | `{ token, newPassword }` | 10                                                  |

Registration commits before attempting email delivery. A delivery error or throttled resend may therefore leave an unverified account; explicitly resend after the failure or `Retry-After`. Signing in before verification returns `AUTH_EMAIL_NOT_VERIFIED` and sends no extra mail. Incorrect credentials return `AUTH_INVALID_CREDENTIALS`. Expired/invalid links and consumed reset tokens return `AUTH_INVALID_TOKEN`. Reset revokes all existing sessions without creating a replacement. Verification is idempotent while its one-hour token remains valid and never creates a session.

Acknowledgements for signup, resend, and reset are generic. Reset requests submit the same conditional email for registered and unknown addresses, so SMTP failure responses do not disclose account existence. Unknown addresses receive a random token that is never persisted and cannot reset an account, including one registered later. SMTP submission is awaited. A rejected recipient, connection/TLS failure, or other uncertain submission returns `503 AUTH_EMAIL_UNAVAILABLE`, without SMTP details, addresses, passwords, or tokens. SMTP acceptance is not proof of inbox delivery. Shared abuse controls and deployment mail monitoring remain release concerns.

Mail contains these fixed destinations, built from validated `WEB_ORIGIN`:

- `/auth/verify-email#token=<verification-token>`
- `/auth/reset-password#token=<reset-token>`

The browser forms at these paths belong to P3-07 and are not implemented yet. Their contract is to read the fragment into page memory, immediately remove it using `history.replaceState`, then POST the token in JSON to the API. Do not put tokens in query parameters, subsequent navigation, browser storage, telemetry, or logs. Public `GET /verify-email` and `GET /reset-password/:token` library callbacks are intentionally not exposed. API auth responses use `no-store` and `no-referrer`; client return navigation must remain token-free.

To enable email locally, run an SMTP capture service bound to loopback and configure the API, for example:

```dotenv
AUTH_EMAIL_TRANSPORT=smtp
AUTH_EMAIL_FROM=accounts@example.test
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURITY=none
```

Restart the API after editing `.env`. Use only disposable addresses/credentials in the local mailbox. Until the browser forms ship, exercise the API with JSON requests and take tokens from this private mailbox; never print links to API logs. Keep delivery disabled if you are only developing guest games. There is no environment-selectable in-memory or log-only sender.

For production, configure an authorized sender and SMTP host, use `starttls` (usually port 587) or `tls` (usually port 465), and supply both `SMTP_USER` and `SMTP_PASSWORD` when required by the relay. TLS certificate validation is always enabled. Store credentials outside source control and never use `VITE_` variables. Production startup rejects disabled delivery and plaintext SMTP. Test verified TLS/authentication, sender-domain configuration, and actual inbox delivery with your chosen service before deployment. Default tests send only to injected mailboxes or a local disposable SMTP server; they make no outbound mail requests.

## Google and GitHub OAuth

Set both credentials for each desired provider in `.env` or deployment secret storage, then restart the API. Empty, partial, malformed, or overlong pairs fail environment validation without echoing their values. Never use `VITE_` for credentials. Callback origins derive exclusively from `BETTER_AUTH_URL`; there is no request-supplied callback host or path. Production still requires the email transport for account recovery.

| Endpoint                        | Request                                                                 | Success                                                                          |
| ------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /api/auth/sign-in/social` | Strict `{ provider: "google" \| "github" }`, exact-origin JSON          | `{ url, redirect: true }`; navigate to this provider authorization URL           |
| `POST /api/auth/link-social`    | Same body, plus a verified account session created within the past hour | Same redirect response; consent links the provider without replacing the session |
| `GET /api/auth/callback/google` | Provider's authorization-code/state response                            | Fixed completion redirect                                                        |
| `GET /api/auth/callback/github` | Provider's authorization-code/state response                            | Fixed completion redirect                                                        |

Starts and linking allow 10 requests/minute/IP each; callbacks allow 20/minute/IP per callback path. All other commands retain exact `WEB_ORIGIN` and JSON checks. Only GET callbacks accept cross-site navigation. The signed state cookie lasts five minutes; library state expires after ten minutes and is consumed on callback. Missing/mismatched/expired state, provider mismatch, and replay fail without signing in. A successful response carries the normal Secure/HttpOnly/Lax session cookie; no session or provider token is returned in JSON.

Completion redirects go only to `WEB_ORIGIN/auth/complete#status=signed-in`, `#status=linked`, or `#error=<AUTH_* code>`. Error codes are `AUTH_OAUTH_FAILED`, `AUTH_OAUTH_CONFLICT`, and `AUTH_REAUTHENTICATION_REQUIRED`; raw provider errors, descriptions, callback codes, and state are discarded. Responses set `no-store` and `Referrer-Policy: no-referrer`. Auth request logs omit callback paths/queries; configure any reverse proxy/access telemetry to do the same. Browser forms and the completion screen ship with the authentication UI milestone; until then inspect the session API using a private browser/HTTP fixture. Do not expose unfinished account navigation in the Arena.

Both providers require a verified email on every callback. GitHub reads the primary address from `/user/emails` even when `/user` hides it. Google uses its server-authenticated UserInfo endpoint. Matching an existing local email without an existing provider link returns `AUTH_OAUTH_CONFLICT`: sign in using the existing method, then explicitly link from that fresh session with the same verified email. A revoked, switched, or stale initiating session cannot complete a link. Provider subject IDs determine returning identity; a changed verified provider email never replaces the stored email or links another account. Provider names are ignored; approved initial avatars are limited to `lh3`–`lh6.googleusercontent.com` and `avatars.githubusercontent.com`. Missing/unsafe avatars use the later profile flow's initials fallback. Tokens, token expiry, scopes, and raw profiles are not retained.

Provider-console setup:

1. In [Google's OAuth setup](https://developers.google.com/identity/openid-connect/openid-connect), create a **Web application** OAuth client, configure its consent screen/audience and test users where required, and register `BETTER_AUTH_URL/api/auth/callback/google` as an exact authorized redirect URI (local default: `http://localhost:3001/api/auth/callback/google`). Store its client ID/secret in the paired Google variables. The app requests only `openid email profile`, for identity/email and the optional avatar; it requests online access and disables incremental scope expansion.
2. Create a [GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app), with homepage `WEB_ORIGIN` and authorization callback `BETTER_AUTH_URL/api/auth/callback/github` (local default: `http://localhost:3001/api/auth/callback/github`). Use separate development/production apps. Store its client ID/secret in the GitHub variables. The only requested [GitHub scope](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) is `user:email`; repository, organization, and private-profile access are not requested.

Before production, manually exercise both consent screens and registered HTTPS callbacks, a GitHub account with a private email, consent cancellation, repeated sign-in, same-email conflict recovery and explicit linking, and sign-out during consent. Confirm cookie/referrer behavior in the target browser/deployment and check application/proxy logs for callback secrets. Automated tests inject only the external HTTP transport while using real Better Auth, Fastify, and disposable PostgreSQL; they do not prove live provider-console consent, redirect registration, or provider availability.

## Private profile API

All routes require the current Better Auth cookie and reject guest-only, forged, expired, and revoked sessions. They accept no query fields or account identifiers. POSTs require exact `Origin: WEB_ORIGIN` and JSON with a 4 KiB body limit. Reads allow an absent origin but reject a different origin. Responses are `no-store`/`no-referrer` and never include email, auth names, tokens, or raw provider profiles.

| Endpoint                       | Request                                      | Behavior                                                                                                     |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/profile`             | None                                         | Read only the current account's profile and onboarding state.                                                |
| `POST /api/profile/onboarding` | `{ username, avatar? }`                      | Choose a username; the same validation applies to email, Google, and GitHub accounts and subsequent changes. |
| `POST /api/profile`            | `{ username?, avatar? }`, at least one field | Atomically update the supplied fields; omitted fields retain their values.                                   |

`username` follows the [accepted character, normalization, reserved-name, and change rules](product.md#usernames-and-avatars). A conflict returns `409 USERNAME_UNAVAILABLE` without identifying the owner; neither field changes. A successful rename immediately releases the old name. An absent profile or null username requires onboarding; reading does not create a row, and an avatar-only change cannot complete onboarding.

`avatar` is `"initials"` to remove the displayed provider image or `"provider"` to select the initial imported image again. It never accepts a URL. Only an existing Google/GitHub binding with a validated initial URL is eligible; absent/unsafe candidates return `409 AVATAR_UNAVAILABLE` on selection and fall back to initials on reads. Linking another provider or returning sign-in does not replace the initial image or undo removal. There are no uploads, refresh-from-provider operations, or API-side image requests.

Success is `{ username, onboardingRequired, avatar, providerAvatar }`. `avatar` contains `source: "initials" | "google" | "github"` and `initials`, plus `url` only for a provider image. `providerAvatar` is the eligible `{ source, url }` candidate or null, allowing an explicit re-selection after removal. Initials use the first two letters/digits of the chosen username in uppercase, skipping underscores; before a username is chosen they are null. Clients must render text safely and fall back to these initials when a remote image fails. Profile forms and image rendering ship with P3-07.

Profile errors use the English catalog with `code`, `message`, and `requestId`: `PROFILE_INVALID_REQUEST` (400), `PROFILE_UNAUTHORIZED` (401), `PROFILE_FORBIDDEN` (403), the two conflicts above (409), and `PROFILE_UNAVAILABLE` (500). Unknown fields, arbitrary account paths, and public lookup/directory operations are unavailable. Session and game ownership continue to use account IDs, never usernames.

## Account-owned game API

The existing public creation, unfinished discovery, details/snapshot, human move, lifecycle, controller, AI turn, invocation, replay, PGN, and provider-discovery endpoints accept a valid Better Auth session. The API derives ownership and human-seat assignments; request bodies never accept user or guest IDs. Human moves/resignation require the assigned human seat, even for an owner. All private reads require current authority, including terminal games after a new game starts.

Account clients must send `X-Neurochess-Identity: account` on public game and provider requests. If the account cookie is absent, expired, forged, or revoked, these requests return `401 UNAUTHORIZED` without bootstrapping or renewing a guest. A present account cookie takes precedence even when the context header is omitted or says `guest`. The header accepts only `account`/`guest`; it never supplies identity. Existing guest clients can omit it. `/guest-session` remains an explicit guest bootstrap for guest play and Sandbox. Account clients do not bootstrap guests for public play.

Sandbox creation/discovery and shared resource URLs for stored Sandbox games always use the guest cookie, independently of account cookies, and remain development-gated. Guest public games stay separate: access them in explicit guest context after leaving the account context. Signing in never changes ownership or consumes the guest slot.

Two sessions of one account share one public unfinished-game slot. A second creation returns `409 GAME_CONFLICT` with the authorized existing snapshot. New account games require a chosen username; incomplete profiles return `403 PROFILE_REQUIRED`. Existing unfinished games remain recoverable, including accounts created before the profile migration, and guest/Sandbox play needs no account profile. Read-only discovery does not pause or take control. A returning device reads the game, then sends the ordinary versioned Pause without a controller ID to recover paused and revoke the previous controller. Keys and explicit Resume/Next move are still required. Expired presence and API restart recovery use the existing [controller protocol](decisions/0011-ai-controller-presence-and-step.md), including when the dispatching login has expired or signed out. Account navigation and forms remain separate roadmap deliverables.

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

These routes use the [account/guest identity selection](#account-owned-game-api), exact-Origin POST checks, private ownership, strict schemas, and `Cache-Control: no-store`. Guests bootstrap explicitly before commands. Keys are accepted only in discovery and turn JSON bodies. Use HTTPS outside localhost development. The public Arena at `/` uses these boundaries for both AI modes. Provider registration is explicit in `apps/api/src/server.ts`; tests inject mocked upstream transport without paid calls.

| Endpoint                         | Request                                                               | Success                                                       |
| -------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `POST /providers/models`         | `{ provider, apiKey }`                                                | `200 { ok: true, models }` or `{ ok: false, error }`          |
| `POST /games`                    | Strict `{ mode, seats: { white, black } }` AI configuration, no keys  | `201 { snapshot, configuration }`                             |
| `GET /games/unfinished`          | No query fields                                                       | `200 { game }`, private details or `null`                     |
| `GET /games/:gameId/details`     | UUID, no query fields                                                 | `200 { snapshot, configuration }`                             |
| `GET /games/:gameId/invocations` | UUID, no query fields                                                 | `200 { gameId, version, turns }`                              |
| `POST /games/:gameId/ai-turn`    | `{ gameId, expectedVersion, commandId, controllerId, step?, apiKey }` | `200` authoritative snapshot, including provider-error pauses |

Ordinary AI games reuse the existing snapshot, human-move, lifecycle, replay, and PGN routes; owning a game does not authorize a human move on an AI seat. A turn's provider/model/settings always come from persisted seat configuration. Its key is used for fresh discovery and inference and never enters a receipt, reservation, or stored record. Invocation reads expose normalized provider failure codes for localization; discovery returns the same safe codes without upstream prose. Empty catalogs are successful discovery results.

`409` AI errors include `AI_TURN_IN_PROGRESS`, `AI_TURN_RECOVERY_REQUIRED`, `AI_TURN_CANCELLED`, and `AI_ADAPTER_UNAVAILABLE`. `422 AI_PARAMETERS_INVALID` means the game was paused because an advertised range or enumeration no longer accepts the saved settings; no inference attempt was dispatched. AI-specific errors contain only `code` and `requestId`. Ordinary game errors retain their existing envelopes. Missing keys fail strict body validation before dispatch. Reads never pause or resume a game.

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

The test service binds loopback port 5433 and uses tmpfs instead of the development volume. Its data is disposable when the container stops. Tests require an explicit PostgreSQL URL whose database name ends in `_test` and reject connection-level `options`; they never fall back to `DATABASE_URL`. Global setup applies reviewed migrations twice. Fixtures use unique guest/account IDs and cleanup deletes only their games and identity records, not whole tables. Concurrent scenarios use independent pools/API instances, and rollback tests fail after an actual SQL insert. Tests never silently skip when PostgreSQL is unavailable.

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

Schema definitions live under `packages/database/src/schema`. Generate SQL with Drizzle Kit, inspect the generated SQL and metadata, and commit both. Apply migrations explicitly; the API does not mutate the schema during startup.

Migration `0007_separate_sandbox_game_slot.sql` replaces the unfinished-owner index with a unique `(owner_guest_session_id, is_sandbox)` index for active/paused games. It does not rewrite game data. Stop old API writers, apply it, and restart the updated API so creation and discovery consistently use their own group. See [ADR-0012](decisions/0012-independent-sandbox-game-slot.md) for the contract and rollback constraint.

Migration `0006_ai_controller_presence.sql` adds the per-game controller UUID/expiry table and cascading foreign key. It does not rewrite existing games or Sandbox data. Stop old API writers, apply it, and restart the updated API; active ordinary AI games without a lease are then paused by the presence worker. Never expire a reservation into another provider dispatch. The [controller ADR](decisions/0011-ai-controller-presence-and-step.md) defines recovery and deployment behavior.

Never edit an applied migration or use schema push as a substitute for reviewed SQL. To update auth persistence, first build shared packages and run `npm run auth:generate`, then retain the application-owned `account_provider_subject_unique` index in the generated schema, format it, and use `npm run db:generate -- --name <name>` and `npm run db:check`. Inspect generated SQL and metadata before applying it. Never run Better Auth's independent migration command or adopt beta/RC Drizzle APIs.

Migration `0010_account_owned_games.sql` makes guest ownership nullable, adds account owner/human-seat foreign keys and indexes, enforces exactly one owner, and restricts Sandbox to guest ownership. Existing guest games, seats, histories, receipts, reservations/controllers, and auth records remain unchanged. Stop all API writers, apply the generated migration, and restart with the account-aware API; older presence workers cannot process account owners. Do not roll back to a guest-only API after account games exist. Keep the forward schema and application cleanup restrictions; no ownership transfer or account deletion is introduced.

Migration `0011_account_profiles.sql` adds the account-keyed profiles table, username constraints/unique index, and avatar preference. It does not backfill usernames from private auth data or modify auth/game rows; existing imported images remain intact. Stop API writers, apply the migration, and restart the updated API so new account-game creation consistently enforces onboarding. Existing accounts create their profile on their first update. Keep the forward schema if rolling back application code; the previous API does not enforce profile completion. Account deletion stays disabled despite the profile's cascading user foreign key.

Migration `0009_oauth_account_identity.sql` adds the unique `(provider_id, account_id)` index without changing existing users, credential accounts, sessions, verification records, or games. Stop API writers, apply the migration, and restart the updated API before enabling OAuth. Conflicting legacy provider bindings must be investigated rather than automatically merged or deleted; the migration fails if they exist. PostgreSQL tests cover upgrades from populated prior auth/game schemas and concurrent claims across account owners.

Migration `0008_better_auth_foundation.sql` adds the generator's four auth tables, unique email/session-token constraints, and indexed user/verification lookups. It does not alter game ownership, seats, moves, receipts, or controller/reservation data. Stop API writers, apply the forward migration, configure the auth origin/secret, and restart the updated API. Populated upgrade tests preserve existing guest AI/Sandbox records and their unfinished limits. Keep the added tables when rolling application code back; do not edit the migration history or delete auth records as a rollback shortcut.

Migration `0002_game_command_receipts.sql` creates the shared accepted-command receipts and backfills existing moves. Stop old API writers before applying it, then start the API version that writes receipts for every move and lifecycle action. See [ADR-0007](decisions/0007-lifecycle-recovery-and-private-replay.md). Integration tests exercise this backfill on a populated prior schema, receipt uniqueness, cascading deletion, and atomic rollback.

Migration `0003_ai_game_configuration.sql` adds nullable ordinary AI mode and participant configuration columns with strict field constraints. Existing human-seat games, including Sandbox in every lifecycle state, receive null configuration fields; their marker, assignments, history, receipts, and owner index remain unchanged. It neither infers providers nor grants Sandbox authority. Unsupported pre-existing AI fixture rows without configuration fail the migration instead of receiving invented settings; recreate those disposable fixtures with explicit provider/model/parameters. Stop API writers, apply the forward migration, and restart the updated API before creating AI records through the service. Old APIs do not validate AI configuration and must not serve those records. Ordinary AI HTTP creation and provider operations remain outside the Sandbox API surface.

Migration `0004_ai_turn_reservations.sql` adds a separate execution-reservation table without modifying existing game data. Stop old API writers, apply the migration, and restart the updated API before enabling AI execution; all ordinary-game writers must invalidate reservations with accepted revisions. Do not delete or expire orphaned reservations to retry inference. Recover through the owner-authorized Pause/Resume path in [ADR-0009](decisions/0009-ai-turn-reservations.md). Integration tests kill a separate executor process and verify recovery, late-result fencing, write rollback, and lost-acknowledgement deduplication using only injected adapters and the disposable database.

Migration `0005_ai_invocation_policy.sql` adds logical AI turns and normalized invocation attempts plus the internal `technical_loss` receipt kind. Stop API writers, apply the generated migration, and restart the updated API before dispatching AI turns. Existing Sandbox/AI records and reservations remain unchanged; historical invocations are not backfilled with invented measurements. Existing uncertain reservations still require explicit Pause/Resume recovery. See [ADR-0010](decisions/0010-ai-failure-policy-and-invocations.md) for retry budgets, interrupted attempts, and atomic outcomes. The private `GameService.invocations` read returns safe attempt data; provider failures return an authoritative paused snapshot from `aiTurn`. The [AI HTTP routes](#ai-provider-and-game-api) expose these contracts without another migration.

## Logging and errors

The API logger omits request bodies, retains only method/path/request ID for requests, strips URL queries, and recursively redacts credential-like object fields. Raw exceptions are reduced to a safe name and non-secret code before serialization; the error serializer preserves only those diagnostic fields when it receives an already-sanitized record.

Auth request paths are reduced to `/api/auth`, so even callback/reset tokens embedded in path segments cannot enter request logs. Better Auth's custom logger discards all library messages/arguments and forwards only a fixed diagnostic level; unhandled library errors are converted at the auth boundary without logging their names, codes, or payloads. Do not replace this sink with the library's console logger or enable adapter debug logs/telemetry.

Idle PostgreSQL pool errors write a fixed, credential-free diagnostic to stderr without terminating the API. The pool remains available for new connections, and `/ready` checks current database availability on every request, returning `503` when its query fails.

System errors retain `code`, `message`, and `requestId`. Structured game errors use the same envelope with enumerated codes; only `GAME_CONFLICT` additionally requires an already-authorized `currentSnapshot`. Messages come from the API's English error catalog, never domain/engine exceptions. Domain failures expose codes and, for an invalid history entry, its one-based ply only. No error accepts arbitrary details or raw exception payloads. Guest/game responses are `no-store`, and the raw guest token appears only in its cookie. Corrupted persisted history or projections yield a safe `500` and leave game data unchanged. Add logging and error tests whenever a new boundary accepts credentials or provider payloads.
