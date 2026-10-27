# Browser integration reference

Use this reference when changing route data, page lifetimes, gameplay presentation or local analysis. Start with the [development guide](../development.md), and keep transport behavior aligned with the [HTTP and WebSocket reference](http-api.md). Test setup and release matrices are in the [testing reference](testing.md).

## Browser routes

`main.tsx` validates the environment, consumes auth callback/reset input, constructs one `createBrowserRouter`, and mounts `RouterProvider` from `react-router/dom` inside the startup error boundary. Add application routes in `app/routes.tsx`; use `Link` or router navigation for local destinations and the pure `routing/route-urls.ts` builders for game/auth links. Test the same tree with `createMemoryRouter` rather than maintaining a parallel route table.

Arena setup is `/`; its live/recovery/replay route is `/games/<uuid>`. Sandbox uses `/sandbox` and `/sandbox/games/<uuid>`. Route segments are case-sensitive. UUIDs accept either case and are validated to lowercase for requests; generated paths use lowercase UUIDs without trailing slashes. A single trailing slash is accepted without a normalization redirect. Missing/malformed IDs, encoded separators, extra segments, legacy `game` queries on entry routes, and mixed path/query game targets show unavailable without application requests. Old query links are deliberately unsupported and never translated or redirected.

Ordinary links push history. Arena creation replaces setup, and New game replaces a terminal Arena path with `/`. Sandbox creation pushes a game path; discovery at `/sandbox` replaces the entry path. Auth completion replaces its entry. Public auth returns allow only `/`, `/history`, `/rooms`, `/rooms/join`, or one validated `/games/<uuid>` path without a query, fragment, extra segment, or trailing slash; invalid targets fall back to `/`. Invitations are never part of an auth return. Sandbox is outside that allowlist.

Keep the mode owner mounted across setup/game leaves and register its memory-only creation handoff before navigating. A pending departure ends gameplay immediately, even if canceled later; explicit recovery is then required. Secrets, invitation values and auth return targets never enter loader/action results. Authorized private entry projections may live in generation-scoped, memory-only loader results under the [routing identity fence](../architecture/browser.md#browser-routing). Never persist private records or secrets in router history state or scroll storage. Fatal route failures show safe localized copy and offer a document reload because failed module loading can be cached by the router/browser.

Static hosting must return the web HTML for these document paths while preserving assets and the separate API origin. Do not proxy all `/games/*` or `/sandbox/*` web requests to the API. Verify the selected host's fallback at deployment. Roll back only to a frontend that supports canonical paths, or use a forward fix; an older frontend cannot open newly shared game links even with HTML fallback.

After building, `npm run smoke` starts the built API and Vite preview. It checks that canonical Arena/Sandbox game paths, account/auth/History and unknown paths return the same SPA HTML without redirects; emitted scripts/styles retain their asset types and missing assets requested with a non-HTML Accept header return 404. Overlapping private paths on the API origin must still return JSON authorization/not-found responses even with an HTML Accept header. Use a running, migrated local database; an environment override may point the smoke API at the disposable test database after integration/browser suites stop.

Vite preview's generic fallback also returns HTML for missing asset URLs when Accept permits HTML or `*/*`. The [production Caddy artifact and rehearsal](../operations.md#probes-and-acceptance) exclude static asset paths from fallback regardless of Accept and verify document routes, MIME/cache behavior and the separate JSON API origin. `npm run smoke` remains the local preview check; it does not establish live-host deployment behavior.

### Extending routes

Public legal documents are separate Vite HTML entries at `/privacy.html` and
`/terms.html`, rendered at build time by `apps/web/legal-pages.ts` from
`src/i18n/legal-en.ts`. They use the shared theme and need neither JavaScript,
an account, nor the API. The common footer opens them in a separate tab to retain
the current game's page lifetime; the homepage also exposes them without JavaScript.
Keep their copy aligned with actual data practices, operator/contact details,
and provider arrangements. These static documents are not React Router routes.

1. Register a case-sensitive leaf in `app/routes.tsx` with page metadata, a feature-owned route component, and a `route-data.ts` loader/action. Preserve literal build gates and lazy module boundaries for development features.
2. Validate URL parameters and action intents before requests. Resolve identity inside each protected leaf, pass cancellation through the validated clients, and return generation-scoped, bounded values. Keep secrets and return destinations out of router results/history state.
3. Pass committed loader data to screen adapters. Require loader revalidation for entry retries; retain controller reads only for explicit command reconciliation, provider discovery, telemetry, replay and PGN. A canceled request never proves a write failed.
4. Preserve shared game owners, creation handoffs and pending-departure cleanup. Define revalidation by cause so metadata/action refreshes cannot repeat recovery or reset live keys.
   Use `routing/use-game-route-controller.ts` and the shared lifetime/navigation services. Keep bootstrap auth callback handling in `auth/auth-entry.ts` and page-shell components in `shell/`.
5. Exercise the actual tree with `renderApp` and `createMemoryRouter`, then cover native link/history/focus behavior in Playwright. `renderLocalized` supplies an isolated router for presentation tests; the isolated setup harness owns its own entry loader and never mounts public identity loaders. Test-only routes remain outside the production tree and module graph.

### Public identity and authentication data

Public leaf loaders and actions use `routing/route-runtime.ts` through the shared helpers in `routing/route-data.ts`. Resolve identity in every protected leaf before private work; parent loaders run independently. `auth/route-data.ts` owns `/auth/*` actions, and `profile/route-data.ts` owns the `/account` loader/action. Account and credential management allow incomplete profiles, while gameplay and History retain shared onboarding. Unknown, invalid, disabled, Sandbox, and reference routes must not start public identity observation.

Use `strictFormIntent` with strict schemas for account mutations, `routeAction` for action lifetimes and expected-account resolution, and `FencedResults` when acknowledged writes must clear issued data or invalidate older reads. Keep endpoint error classification in the feature and adopt the settled generation only for an intentional identity transition. History and Credentials use `selfPostRevalidation` because their screens explicitly reconcile writes. See the [routing architecture](../architecture/browser.md#browser-routing) for ownership and cache guarantees.

The runtime lives with the router, independently of React effect replay. Dispose the router when removing its provider; the application test renderer does both on unmount. Mode layouts adopt handoffs during layout and start entry work after commit, so StrictMode replay can cancel before a recovery command is dispatched. Owners registering during a pending departure must observe that destination immediately.

Return generation-scoped values through the runtime and check their generation before rendering. Invalidation clears the values shared with router caches immediately; revalidation alone cannot hide obsolete data while a new read is pending. Keep session/profile projections in the account service, and preserve its BroadcastChannel, focus/pageshow, interval, expected-account, and request-cancellation fences. Refreshing a profile for the same identity must not replace a game owner.

Auth forms submit to route actions and use fetchers for same-page acknowledgements. Return only bounded error/field codes and notices. Keep passwords in bounded form/request memory, clear fields after submission, and reset forms/fetchers on external identity changes and pagehide. Reset actions read the token from the bootstrap closure only when submitted; StrictMode replay does not consume it. Success, route departure, and pagehide destroy it. OAuth leaves through the existing validated provider URL. Sign-out includes the displayed account expectation, so a delayed submission cannot revoke a replacement account.

### Arena entry data

`public-game/route-data.ts` defines read-only setup and game loaders; `public-game/public-game-route.tsx` selects the AI or room route through declared feature entrypoints. Keep controllers and recovery policies in `match` and `rooms`; neither feature imports the selector. Validate the route target before identity resolution, use the existing validated clients with `request.signal` and the resolved identity, and return generation-scoped results. Setup receives the unfinished-game ID or an empty entry; a missing guest never triggers bootstrap. Account entries include masked key metadata when setup or unfinished AI play needs it, seeding the credential catalog without a second initial read.

`MatchRoute` keeps the AI controller owner across both leaves. It adopts entry data only on committed entry or an explicit entry-read retry. A created-game handoff skips the duplicate details read; other unfinished AI entries recover through the controller's versioned Pause. Same-game action revalidation preserves the live owner; explicit revalidation reads fresh data without replaying recovery or replacing its accepted snapshot. Access denial clears the private view. A canceled departure remains stopped until a user retry fetches fresh data. Keep telemetry, replay, PGN, discovery, uncertain-command recovery and gameplay mutations in their existing feature lanes.

The authorized server mode dispatches human games to `RoomRoute` and its dedicated controller, without AI leases or credential reads. Open **Private rooms** at `/rooms` to create a room or follow `/rooms/join#invite=…` to join explicitly. Waiting, live play and terminal replay share `/games/:gameId`. The room controller adopts the memory-only creation/join handoff, synchronizes each new WebSocket connection, accepts revisions monotonically, and keeps presence separate from lifecycle. A lost move acknowledgement freezes new commands until an accepted revision resolves it or the user explicitly retries the identical command. Reconnect uses bounded backoff followed by a user retry; resignation and owner closure always require a fresh confirmation. Departure, pagehide and identity loss retire sockets, requests and private state.

## Sandbox UI

`sandbox/sandbox-route.tsx` and `sandbox/route-data.ts` load lazily behind the Sandbox flag. Entry loaders own readiness and guest-authorized discovery/snapshot reads; `useSandbox` consumes committed results. Keep Start, versioned recovery, command reconciliation, replay and PGN in the controller. Revalidation may update readiness or clear denied access, but must not repeat recovery, replace a live snapshot, or reset an uncertain command. Retry connection and failed entry reads use loader revalidation; command retries retain their original payloads. Reference fixtures use their own API-independent branch.

Set `SANDBOX_ENABLED=true` in the local `.env`, apply migrations, and run `npm run dev`. Open `http://localhost:5173`, choose **Sandbox** in the header, then **Start sandbox**, or open `http://localhost:5173/sandbox` directly. Arena at `/` provides the separate [AI-versus-AI flow](http-api.md#arena-controller-api); loading setup reads unfinished-game discovery without creating a guest. When disabled, Sandbox is absent from navigation and direct links show an unavailable page without mounting the game client. The Sandbox service indicator checks the database through `/ready`; API creation and access checks remain authoritative if web and API settings differ.

One guest controls White and Black. Select a source and a highlighted destination, or use the [board keyboard controls](../design-system.md#keyboard-and-chess-interaction). Promotion always requires an explicit piece choice. Flip board changes presentation only. Pieces, turn, result, and SAN history stay unchanged until an authoritative response arrives.

The entry screen shows a read-only standard-position preview. Its single **Start sandbox** action sits in the desktop rail and before the board on mobile; inspecting the preview never creates a guest session or submits moves. Sandbox has its own [unfinished-game limit](../product.md#development-sandbox): starting or recovering it does not select or modify an unfinished Arena game, and an unfinished Sandbox does not block Arena setup.

An uncertain submission keeps the original move or lifecycle command in memory. **Check game status** reads the authorized snapshot; **Retry same move** or **Retry same command** reuses the original ID, version, and payload. A same-version GET is still uncertain because the first request could commit later. Rejections also require synchronization before another command. Access loss clears the private position, replay, and export text, returns to the standard-position preview, and requires **Start sandbox again**.

Creation updates the private URL to `/sandbox/games/<uuid>`. Refresh, reopening that URL, or opening `/sandbox` with an existing guest discovers the game without bootstrapping a new guest. Visiting Arena leaves the game unchanged; returning to Sandbox uses paused recovery. Recovery pauses an active game through a versioned command before enabling controls; an already-paused game requires no write. Choose **Resume** explicitly to continue. Concurrent active snapshots are reconciled with at most three pause attempts before **Retry recovery** is offered. An uncertain pause follows the same command retry flow as a move.

**Pause** and **Resume** preserve the position and history. **Abort**, **Resign White**, and **Resign Black** are available while active or paused. The confirmation dialog initially focuses Cancel and explains the outcome. Abortion displays **Game stopped**, keeps result `*`, and releases the unfinished-game slot. Resignation awards the other color the win, including when the resigning color is off-turn.

Completed and aborted games show their result and termination reason, open replay at the final ply, and offer **First**, **Previous**, **Next**, **Last**, and selectable SAN moves. Replay changes only the displayed position. **Copy PGN** and **Download PGN** fetch the private, authorized export endpoint; clipboard failure reveals selectable text. A download contains the canonical UTF-8 text in `neurochess-<uuid>.pgn`. **New game** preserves the previous record and private URL; browser Back can reopen it. Access remains limited to the owning guest until the existing inactivity expiry (24 hours by default). This development flow exposes no recent-games list and performs no retention cleanup.

Visible copy and document metadata come from `apps/web/src/i18n/en.ts`. Use complete messages and named placeholders; keep UCI, SAN, and coordinates unchanged. The i18next resource declaration type-checks keys, falls back to English, and ships no browser-language detection. Inter and Orbitron are bundled locally. API error codes map to catalog entries; do not display server messages or caught exceptions.

Presentation uses Tailwind CSS utilities in JSX. The [design-system tokens](../design-system.md#foundations), base layer, and the few custom utilities live in `apps/web/src/styles.css`; shared controls sit under `apps/web/src/ui`. Prettier sorts class names, so run `npm run format` after editing markup. Tests select elements by role, accessible name, or data attribute rather than by class.

## Arena reference scenarios

With `SANDBOX_ENABLED=true` and Vite running in development, open [the arena reference screen](http://localhost:5173/dev/arena). This page needs no running API, database, guest session, or provider key. Production builds and Sandbox-disabled apps show the unavailable page at this URL.

Choose Human vs human, AI vs human with either human color, AI vs AI, or identical models with long names. Live and Replay use the same shared components as Sandbox. The board is for inspection; Pause/Resume, flip, confirmed resignation/abort, and replay navigation affect only the in-memory fixture. The chess package derives all positions and results from the standard-position sample game. Reloading or selecting another scenario resets the fixture.

All sample identities, commentary, and measurements are explicitly labeled **Test data**. Human seats omit AI details; only the supplied human seat receives a resignation action. AI scenarios exercise commentary/telemetry slots and opt-in Moves/Analysis/Events tabs. Replay synchronizes sample details with the selected position. Missing commentary, missing usage/pricing, and the initial position have explicit empty/unavailable states. Analysis is a labeled extension slot; no Stockfish or provider is invoked.

The reference adapter and data live in `apps/web/src/reference`; reusable composition lives in `arena/arena-details.tsx` and `ui/detail-tabs.tsx`. Keep fixture data and adapters out of shared presentation components. Cover every scenario's seat/capability mapping in `apps/web/src/reference/arena-reference-screen.test.tsx`; extend `test/e2e/arena-reference.spec.ts` when a new capability needs browser-specific geometry, scrolling, or native interaction coverage. This is a UI reuse check, not acceptance of real AI orchestration or room permissions.

## Account UI

Use `/auth/sign-up`, `/auth/sign-in`, `/auth/verify`, `/auth/forgot-password` and `/auth/reset-password` for the email lifecycle, or the Google/GitHub buttons on the entry forms. Configure the corresponding API transports above; an unavailable method offers a safe error and another sign-in path. Registration and verification require a subsequent explicit sign-in. Request acknowledgements describe receipt, never guaranteed email delivery. The password reset form removes its token fragment immediately and requires a fresh sign-in after completion.

Every method reaches username onboarding before account gameplay. `/account` edits the private profile, renames the username, removes an imported avatar, and offers sign-out and [account deletion](http-api.md#account-deletion). Its loader projects the validated account-service profile; profile/avatar/deletion fetcher actions validate the displayed account expectation. Shared onboarding submits to the same action and returns through the allowlisted destination. Deletion remains available before onboarding and preserves the recent-sign-in and uncertain-acknowledgement rules. Provider image failures use initials; uploads and arbitrary URLs remain unavailable. Public setup, game controls and recovery use account authority without guest bootstrap. Guest games remain separate, and Sandbox remains guest-only. [Provider keys](#credential-ui) opens account credential settings; [History](http-api.md#private-game-history) opens private results and terminal game deletion.

Sign-in/out, cross-tab changes, expiry and reset invalidation clear page keys and private state. The browser uses a non-secret sessionStorage account-intent marker, BroadcastChannel notifications, focus/pageshow checks and 15-second observation; API authorization remains authoritative on every operation. Public requests include `x-neurochess-identity` and `x-neurochess-expected-account` (observed UUID or `guest`); profile reads/updates and sign-out include the expectation. These optional expectations can only deny a changed identity, never supply one. Missing cookies on a previously authenticated page require sign-in or explicit guest continuation. Returning to an existing game requires paused recovery and fresh keys; login never resumes it automatically.

Run `npm run test:e2e -- test/e2e/accounts.spec.ts` against the isolated browser server for desktop/mobile email and injected Google/GitHub flows, profile editing, account play, paused return, session switching and reset revocation, late-response fencing, safe links, keyboard and enlarged-copy coverage. Test-only mailbox/OAuth routes and transports live in `test/e2e/account-harness.ts`; they are absent from production. Browser clients receive isolated fixture socket identities for the real database-backed rate limiter. Teardown tracks immutable user IDs from actual registration results and new-user OAuth callbacks, never email addresses encountered during reset or sign-in. It removes those users and their games, plus individually tracked sessions, reset/OAuth records and fixture rate-limit entries, after draining email work. No test sends real email or performs a live OAuth exchange; production consent and SMTP delivery still require the manual checks above.

## Credential UI

Open **Provider keys** at `/account/credentials` to save a labeled key, inspect masked metadata, revoke one key or clear all saved keys. Management is available before username onboarding. Saving requires the unchecked **Save this key to my account** opt-in and explains persistence before submission. Submitted raw values are cleared, including when acknowledgement fails; an uncertain save refreshes metadata and reconciles its ID before another save is offered, and later attempts reuse that ID until it is settled. Revoke/clear dialogs initially focus Cancel and explain the accepted in-flight result policy. Navigation to settings ends the current match controller; returning to its private URL recovers paused.

`credentials/route-data.ts` owns the metadata loader and the distinct validated `save`, `revoke` and `clear` action intents. Settings consume the entry loader once. Notifications and explicit refresh use that same loader through a fetcher, including from live Arena screens; they do not revalidate game entry or reset its controller. Forms reset secrets and scoped fetcher outcomes on identity change, pagehide and exit. Confirmed removal clears issued catalogs before refresh, so failed or delayed reads cannot resurrect removed rows. Actions return bounded outcome codes; raw keys stay in form/request memory.

Setup and paused recovery default every AI seat to **Use for this tab**. Accounts may explicitly choose a saved key matching that seat's provider. Source/provider changes cancel obsolete discovery and discard its model/capability selections. Metadata refreshes on focus, pageshow, a 15-second interval and payload-free cross-tab notifications; they never select a key. Raw keys, saved selections and private metadata clear on identity changes/pagehide. Missing or rejected keys offer saved selection or session-key replacement, followed by explicit Resume or Next move. Guests retain session-only fields and account-storage guidance.

Run `npm run test:e2e -- test/e2e/credentials.spec.ts` for desktop/mobile source combinations, both human colors, refresh, revocation, unavailable encryption, rejected keys, account switching, privacy and accessible settings. The isolated browser server uses the actual credential service and PostgreSQL with a process-local test encryption key and injected provider transports. These tests make no paid provider calls and do not establish live key validity.

## Browser analysis service

`apps/web/src/analysis` owns the reusable browser service described by the
[Stockfish contract](../architecture/analysis.md#stockfish-worker). Create one `AnalysisScheduler`
per authorized game view with its identity/game lifetime and complete canonical
history. `show(ply)` selects the foreground position; `updateHistory` accepts only
extensions of that history. `seed` accepts bounded, verified-prefix samples in page
memory and preserves older profiles until replacement. Subscribe to per-ply states;
analysis never calls game commands or provider clients.

Prefix validation uses the domain's read-only `replayPositions` iterator and yields
between batches of at most eight plies or after eight milliseconds of elapsed batch
work (an individual rules-engine step is indivisible). Seed batches share one replay
pass, and lifetime cancellation interrupts validation before any new worker starts.

Bind it with `bindAnalysisLifetime`, supplying the view's abort signal and an access
reauthorization callback. Abort that signal on navigation, identity/access loss, or
acknowledged deletion, and call the returned cleanup on unmount. Visibility return
must complete reauthorization before computation resumes. Use `retry(ply)` only for
an explicit analysis Retry; it is independent of provider recovery. Feature adapters
own authorized history and access refresh; the service does not discover games or
grant access. Delivery status is in the [roadmap](../roadmap.md#phase-5--analysis-polish-and-release-hardening).

`gameplay/analysis-binding.ts` connects accepted match, room and Sandbox snapshots
to the scheduler through a separate `GameAnalysisController`. It owns cancellable
sample reads, one upload at a time (up to 32 samples), retained-write convergence,
and explicit saving retries. Feature adapters supply read-only access refresh and
the replay selection; shared arena components receive data and callbacks. Account
samples persist through the private API, while guests and Sandbox remain in page
memory. Engine Retry and saving Retry never issue game commands. An obsolete
profile requires a page reload.

Run `npm run test:e2e -- test/e2e/evaluation.spec.ts` for the five-project browser
acceptance of all public modes, private saved replay, independent room samples,
worker failure and unsaved-result recovery. Provider fixtures assert that their
chess context contains no analysis, opponent commentary or identities.

Vite verifies and emits only the pinned lite single-threaded pair under
`<base>/engines/sf19-lite-single-v2/`. Its `index.html` links the manifest, exact
source archive, embedded network, notices and rebuild instructions from
`apps/web/vendor/stockfish`. Ordinary application entry does not fetch the engine.
Stockfish 19.0.1 has no install script; builds consume the versioned files directly.
The source rebuild separately pins Emscripten and Terser through the manifest and
`build-package-lock.json`. Keep corresponding source materials with every distributed version.
An engine rollback must retain all registered analysis profiles so samples already
stored by a newer engine remain readable; change the current profile without removing known entries.
The application license and compatibility policy are selected in
[ADR-0021](../decisions/0021-project-license-and-source-distribution.md). Web builds
also package the application build sources and GPL text using `tar` on PATH;
the [licensing policy](../licensing.md) covers rebuilds and public source/notice checks.

Run `npm run test:unit -- apps/web/src/analysis apps/web/stockfish-assets.test.ts`
for protocol, scheduler, lifetime and distribution checks. Run
`npm run test:e2e -- test/e2e/analysis.spec.ts --workers=1` for the real engine in an
isolated production build, including a non-root application base, private deep
links, JS/WASM failures, explicit Retry, and verified no-move checkmate. The test
entry is added only to that temporary build. These are correctness checks, not
device performance measurements. WASM load rejection may surface only through
the bounded initialization timeout in the upstream loader.

### Responsive layouts and performance budgets

Run `npm run test:e2e -- test/e2e/responsive-analysis.spec.ts --workers=1` for entry,
live analysis, credential recovery, replay/Events, history, account and credential
settings, and room invitation/replay layouts. The desktop and touch projects together
cover 320, 390, 768, 1024 and 1440 CSS px, long model/credential/participant labels,
expanded translations and 200% root text. The short-viewport check verifies focused
fields and actions remain reachable; it does not emulate an operating-system keyboard.

`npm run build` uses `apps/web/build.ts` to set production mode before Vite resolves
the shared API environment. This keeps development React out of production web
artifacts even when the API's `NODE_ENV` is `development` or `test`.

Run `npm run test:performance` separately from integration and other browser suites:
they share the disposable database and ports. It builds a temporary production web
artifact through the same build entry, serves
it with Vite preview solely as a test harness, and uses the real application/API,
injected provider transports and packaged Stockfish. It does not exercise production
hosting or call paid providers. CI runs each viewport project in its own performance
job with one Playwright worker, independently of the browser shards, and retains only
allowlisted numeric measurements and asset names.

Budgets for this repeatable Chromium lab profile:

| Measurement                                                           | Budget                                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Initial requested JS + CSS, sum of individual gzip sizes              | 300 KiB (1 MiB uncompressed)                                                                       |
| Engine JS + WASM pair, uncompressed                                   | 2 MiB; zero engine requests on entry/account routes                                                |
| Worker creation through first `readyok`, cold localhost fetch         | 2 seconds                                                                                          |
| Exported WASM linear-memory allocation after initial/live analysis    | 160 MiB                                                                                            |
| Worker JavaScript used heap                                           | 16 MiB                                                                                             |
| Sampled worker CPU active fraction during live/200-ply replay windows | 90% of one worker thread                                                                           |
| Human move through UI and local API acknowledgement                   | 1 second                                                                                           |
| Board DOM commit through two animation frames                         | 100 ms                                                                                             |
| Open 200-ply private replay / select a position through two frames    | 2 seconds / 200 ms                                                                                 |
| Worker lifetime and scheduling                                        | Peak one, zero after hide/unmount; no dispatch while hidden; at least 250 ms idle between searches |

The initial reference host is Windows 11, Intel Core Ultra 5 225F (10 logical CPUs),
32 GiB RAM, Playwright 1.63.0 Chromium 153, with 1440×1080 desktop and 390×844 Pixel 7
touch emulation, no CPU/network throttle, and localhost transport. Each run records
its actual browser, host and viewport alongside timings. Size budgets are deterministic;
timing/CPU limits include headroom for the CI runner and are regression gates, not
field-performance or physical-device guarantees. Investigate changed artifacts,
environment and repeated measurements before changing a budget.

Reports are printed to the command output and written under the configured Playwright
performance output directory (by default the OS temporary directory). Gzip sizes are
computed comparisons; the local preview transfer is uncompressed. Resource Timing
records the WASM transfer separately. A separate memory-only test wraps WASM
instantiation to read exported memory sizes, because the CDP JavaScript heap excludes
WASM linear memory. Timing and CPU runs use untouched engine assets. These memory
figures exclude browser/native overhead and do not replace the profile's verified
2 GiB compiled maximum. CPU sampling reduces the profile to numeric active/elapsed
time; raw stacks, UCI, private game content, cookies and keys are not retained.

Delayed and rejected JS/WASM loads must leave moves, terminal replay and explicit
analysis Retry usable. Repeated in-app mount/dispose and injected visibility events
must terminate workers and resume missing work through access revalidation, without
accumulating workers or queues. Headless visibility events exercise the application
handler; actual OS backgrounding, low-memory phones, browser zoom, safe-area hardware
and on-screen keyboards remain manual release checks. See the [current validation
limits](../design-system.md#validation-limits).
