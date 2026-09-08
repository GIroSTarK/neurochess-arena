# Verification guide

This guide owns verification requirements, focused commands, coverage, and the opt-in live-provider procedure. The [roadmap](roadmap.md) owns milestone status; [design validation](design-system/validation.md) owns current browser and accessibility limitations.

## Required checks

Every change, including documentation, must pass the configured baseline before handoff. Prepare the disposable test database and the explicit `TEST_DATABASE_URL` from `.env.example`:

```text
npm run infra:test:up
npm run verify
```

`verify` runs formatting, lint, typecheck, unit tests, PostgreSQL integration tests, architecture checks, and build. The [root command table](development.md#root-commands) lists individual commands. Use focused checks while iterating, then run the baseline once the change is ready.

| Change or checkpoint                                                         | Additional required checks                                                                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation                                                                | Validate changed local links/anchors, referenced files, command names, and examples against their sources.                                      |
| Browser UI, chess/game flows, or API/session contracts affecting those flows | Run the complete `npm run test:e2e` suite after the baseline; install Chromium as described below.                                              |
| Database schema or migrations                                                | Review generated SQL, run `npm run db:check`, and cover populated-schema upgrades, constraints, and rollback in the integration suite.          |
| Build, dependency, startup, or deployment configuration                      | Run `npm run smoke` after building, with PostgreSQL available.                                                                                  |
| Milestone acceptance                                                         | Run the full browser suite and verify the milestone exit criteria and applicable MVP acceptance requirements. Record remaining coverage limits. |

Browser, migration-metadata, and smoke checks are separate from `verify`. CI runs Docker Compose validation, migration application twice, `db:check`, `verify`, the complete browser suite, and the built-service smoke. Real-provider smoke is never part of these commands.

Add or update tests for behavior changes. Report commands actually run and relevant results in the change summary, PR, or CI. Keep progress in the [roadmap](roadmap.md) and current validation gaps in [design validation](design-system/validation.md); do not append run logs to canonical guides.

## Provider contract tests

Run the shared AI schemas, canonical context, parameter resolution, and scripted provider checks without network access or provider credentials:

```text
npm exec vitest -- run packages/contracts/src/ai.test.ts packages/contracts/src/provider-transport.test.ts apps/api/src/providers
```

Use `createScriptedMockProvider` from `apps/api/src/providers/mock.ts` in server tests. Supply a provider descriptor, fixture model descriptors, and ordered move steps containing either `output` (structured data or JSON text, including malformed fixtures) or a classified provider `error`. Optional telemetry supplies deterministic latency and reported usage; omitted telemetry means simulated zero latency and unavailable usage. `discoveryError` scripts a model-list failure. The mock consumes one step per valid request and throws `MOCK_SCRIPT_EXHAUSTED` when the script runs out, so unintended extra attempts fail tests.

Request captures contain defensive copies of effective configuration, canonical context, and the common response instruction; they omit API keys and abort signals. Use placeholder credentials only. The mock does not perform retries or game commands. Integration tests inject it into the real [guest AI service](game-protocol.md#ai-game-api). The reusable `apps/api/test/provider-contract.ts` suite also runs against real adapters with mocked HTTP. The [provider registry](providers.md#ai-provider-boundary) validates discovery and move results before response serialization, caching, or persistence.

## PostgreSQL integration tests

Add `TEST_DATABASE_URL` from `.env.example` if updating an existing `.env`, then run:

```text
npm run infra:test:up
npm run test:integration
```

The test service binds loopback port 5433 and uses tmpfs instead of the development volume. Its data is disposable when the container stops. Tests require an explicit PostgreSQL URL whose database name ends in `_test` and reject connection-level `options`; they never fall back to `DATABASE_URL`. Global setup applies reviewed migrations twice. Fixtures use unique guest IDs and cleanup deletes only those guests' games and sessions, not whole tables. Concurrent scenarios use independent pools/API instances, and rollback tests fail after an actual SQL insert. Tests never silently skip when PostgreSQL is unavailable.

CI uses its own ephemeral `neurochess_test` database and runs integration tests through `npm test`. Unit tests and architecture checks remain runnable without PostgreSQL. Keep `TEST_DATABASE_URL` pointed only at a dedicated disposable database, never shared or production data.

## Browser tests

After the [required baseline](#required-checks), install Chromium and run:

```text
npm exec playwright -- install chromium
npm run test:e2e
```

Playwright starts isolated Fastify/Vite services at `http://localhost:3101` and `http://localhost:5174` and refuses to reuse existing servers. Its entrypoint applies the same explicit `_test`/no-options database guard and reviewed migrations as integration tests, with no fallback to `DATABASE_URL`. No arbitrary-position endpoint is exposed.

AI tests use mock providers with the real game services and database. Setup fixtures hold the first turn until cancellation; gameplay fixtures return legal moves from the standard position, including an eleven-second delayed response. Selected recovery regressions intercept transport before reservation or fail lifecycle read-back; the acceptance matrix below leaves all game API responses real. Automated providers never make paid calls.

Desktop Chromium and a Chromium mobile-touch context cover sandbox completion through Fool's Mate, refresh/paused recovery, replay, PGN, both resignation colors, abortion, guest isolation, private URL reopening, and White-knight/Black-rook underpromotion through legal play. Downloads must match persisted PGN exactly; clipboard readback normalizes Windows CRLF conversion while the client writes canonical text unchanged.

Accessibility/layout checks cover keyboard direction and Tab order, dialog focus containment/return, 44px controls, reduced motion, 320/390/768/1024/1440px layouts, 200% root-text enlargement, 50% expanded test resources, stable move-history placement, and axe checks. Expanded resources are injected into the dev module, not shipped as a product locale or flag.

Each context has an isolated guest. Cleanup deletes only guests/games created by the test; the server also tracks its guests for graceful shutdown. Screenshots and failure context go to `neurochess-playwright-results` in the OS temporary directory. Traces, HARs, and videos are disabled to avoid recording credential-bearing headers. These checks do not certify other browser engines, actual screen-reader speech, physical devices, or browser/OS zoom; see [validation limits](design-system/validation.md).

### Focused browser suites

For iteration, use `npm run test:e2e -- test/e2e/<suite>.spec.ts`. Full-suite requirements remain as specified above.

| Suite                                      | Focus                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `sandbox`, `move-history`, `accessibility` | Shared chess interaction, lifecycle/replay, layout, and accessibility                                         |
| `ai-setup`                                 | Independent/identical seats, human colors, discovery/capabilities, validation, and credential isolation       |
| `ai-playback`                              | Completion, thinking-time pause/stop, paused steps, speed, and confirmation across accepted moves             |
| `ai-human`                                 | Both colors, keyboard/touch seat authority, promotion, and resignation during thinking                        |
| `ai-recovery`                              | Refresh/key loss, repetition history, offline/close/back navigation, and uncertain turn recovery              |
| `ai-telemetry`                             | Attempt/error history, explicit retry, zero/unavailable usage, inert commentary, replay, and exact PGN        |
| `ai-feedback`                              | Both live retry labels, stable controls/board/focus, pause during retry, and per-seat rejected-key correction |
| `ai-acceptance`                            | Provider pairing, completion, privacy, single-game limit, and failure matrix below                            |

### Phase 2 acceptance coverage

Run the complete browser suite for milestone handoff. The additional acceptance matrix can be run independently with:

```text
npm run test:e2e -- test/e2e/ai-acceptance.spec.ts
```

Both configured projects run every acceptance case. All creation, discovery, turn, lifecycle, replay, and authorization requests reach the actual Fastify services and PostgreSQL. Only provider adapters are replaced, using unique placeholder keys and the shared scripted mock; no browser routes replace game responses in this acceptance file. These fixture model IDs and outcomes do not establish live-provider compatibility.

| Acceptance requirement                                       | Evidence in the browser suite                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every supported provider pairing, including identical models | `ai-acceptance.spec.ts`: all 16 ordered White/Black pairings complete checkmate; independent temperatures and seat credentials, accepted commands, moves, reservations, and attempts agree with PostgreSQL                                                                   |
| AI versus human                                              | `ai-acceptance.spec.ts`: both human colors complete against each of the four providers; `ai-human.spec.ts` adds seat restrictions, underpromotion, and resignation                                                                                                           |
| Invalid-output exhaustion and authoritative legality         | `ai-acceptance.spec.ts`: malformed/illegal outputs and an adapter falsely returning an illegal move as success both end at exactly three invalid attempts; no invalid move is stored, duplicate commands cannot call again, and replay stays available                       |
| Provider-error recovery and retry accounting                 | `ai-acceptance.spec.ts`: auth, quota, timeout, and unavailable failures pause both modes until explicit continuation; invalid counts survive a provider failure and a fresh manual retry                                                                                     |
| Pause, step, resume, speed, Stop                             | `ai-playback.spec.ts`: pause during thinking, one paused step, explicit resume, no post-stop progression, delayed responses, and confirmation against the latest accepted move                                                                                               |
| Refresh and key re-entry                                     | `ai-recovery.spec.ts`: both modes, both human colors, independent configuration, full repetition history, empty masked inputs, no continuation on key entry, offline/close/back navigation; `ai-feedback.spec.ts` adds rejected-key replacement without refresh              |
| Private access and the single-game limit                     | `ai-acceptance.spec.ts`: anonymous and isolated guests cannot read snapshots/configuration/attempts/replay/PGN or issue turns/moves/controls; active and paused games block all three creation paths; racing creation admits one winner and completion/Stop release the slot |

The configured baseline also exercises all real provider adapters with mocked HTTP, the server's lease/idempotency rules, migrations, and credential redaction. Browser fixtures do not certify current upstream catalogs, account entitlements, or live generation. Record actual live coverage separately using the procedure below; milestone status belongs in the [roadmap](roadmap.md#phase-2--ai-arena-core).

### Opt-in real-provider smoke

This manual procedure makes real provider requests and may incur charges, including up to three generations for an invalid turn and calls already in flight when Pause or Stop is selected. Run it only when the operator explicitly opts in with their own keys and a spending limit. It is excluded from `npm test`, Playwright, and CI; no real-provider environment switch or stored test credential is needed.

1. Follow [local setup](development.md#local-setup), using the ordinary development database and `npm run dev`. Open the configured web origin (normally `http://localhost:5173`). The acceptance services on ports 3101/5174 always use mocks. Use HTTPS for any non-loopback environment that handles keys.
2. For each of **OpenAI**, **Anthropic**, **Google**, and **OpenRouter**, open AI versus human with human White. Enter that provider's key only in the masked **API key** field and select **Load models**. Choose a model returned by that account's live discovery, record its exact ID, and leave unsupported parameters unset. If setting an output limit, use an advertised value sufficient for the model; an excessively small limit can itself cause invalid-output retries.
3. Start and make one legal human move. Wait for one accepted AI reply or the classified paused/terminal outcome. Verify the board and move history agree, optional commentary is plain text, and absent usage is **Unavailable**. Do not submit another human move. Pause and confirm Stop to release the slot. Repeat with human Black: the opening AI turn starts automatically; stop after its outcome. Report discovery-only or failed generation separately from an accepted turn.
4. With an explicitly chosen pair of provider/model configurations, test AI versus AI, then an identical-provider/model match with independently selected parameters. Start and immediately Pause; an initial call may already have begun or completed. Once paused and synchronized, select **Next move** once per desired turn. Each successful step must add exactly one move and remain paused. Check both colors, then confirm Stop. Treat speed as presentation only, never as a spending limit.
5. In a paused unfinished match, refresh, choose **Return to game**, and verify the same accepted history/configuration. **Resume** must stay unavailable until each missing key is re-entered. Applying keys alone must leave the game paused. For a rejected key, choose **Update key** beside that model, enter its replacement, and apply it without reloading. Confirm the other seat and board remain unchanged, then explicitly choose **Retry move**. Use one explicit step or continuation, then Stop. Do not retry auth/quota failures until the credential or account condition is corrected.
6. Capture only safe results: date, commit, browser/viewport, provider and exact model IDs, effective parameters, tested mode/colors, discovery result, accepted turn count, normalized outcome/reason, and whether a complete game or only a bounded smoke was exercised. Never include keys, cookies, request headers/bodies, HARs, traces, or raw provider exceptions. For each unrun provider write **Not tested live**, not **Passed**. A smoke verifies only those selected models/accounts; full live completion evidence additionally requires completing and replaying both modes, within the operator's separately approved spending limit.

Intermediate retry feedback uses private snapshot polling, so very short attempts may finish between reads; final history retains every recorded attempt. Automated acceptance and bounded live smoke results retain the [browser/device limitations](design-system/validation.md).

## MVP acceptance

- Unit tests: chess state transitions, legal move validation, result rules, provider normalization, retry classification, cost calculation, and redaction.
- Integration tests: Fastify routes, Better Auth authorization, Drizzle repositories, migrations, credential encryption, deletion cascades, and idempotent AI turns.
- WebSocket tests: invitation join, move broadcast, disconnect/reconnect snapshot, owner abort, and unauthorized access.
- Provider contract tests: recorded or mocked responses for every adapter; no live paid calls in the default suite.
- End-to-end tests: the three game modes, guest restrictions, history/replay/PGN, responsive layouts, and key lifecycle.

Sandbox acceptance must additionally verify:

- one guest completes a game through human commands, replays it, and exports PGN without loading a provider adapter; another guest cannot read or mutate any of these resources;
- sandbox creation/control paths are unavailable when disabled, production cannot enable them, and ordinary games never inherit authority over both seats;
- concurrent game creation respects the active/paused limit, completion or abortion releases the slot, and duplicate move submissions append only one move;
- refresh recovers an unfinished game paused, and resume preserves the full move history;
- repeating `g1f3 g8f6 f3g1 f6g8` twice from the initial position ends the game on the eighth half-move, including after database restoration between the cycles;
- internal fixtures verify the 99-to-100 half-move boundary, pawn/capture counter resets, repetition identity, and checkmate priority without exposing arbitrary-FEN creation;
- completed and aborted games reject new moves, and replay/PGN agree with the persisted result and termination reason.
