# Repository instructions

## Project intent

Neurochess Arena is primarily an arena for observing and comparing LLMs playing chess. AI versus AI is the flagship mode. AI versus human and private online human versus human are also required for the MVP.

## Sources of truth

Rules below always apply. Before a material change, read the sources and sections relevant to the task, following linked contracts as needed. Do not read every document or ADR by default; reuse guidance already read in this task unless it changed.

- `docs/product.md`: game behavior, permissions, and MVP scope.
- `docs/architecture.md`: component boundaries, data flow, persistence, and security.
- `docs/design-system.md`: presentation, UI interaction, and accessibility.
- `docs/development.md`: setup, environment, API usage, migrations, and verification.
- `docs/roadmap.md`: delivery order and milestone status, when planning work or assessing progress.
- `docs/decisions/README.md`: find and read the accepted ADRs relevant to the affected area.

When code and documentation disagree, determine the intended behavior before editing. Correct whichever is wrong; update both when the contract changes. Do not change a requirement merely to match a bug.

## Technical baseline

- Use npm workspaces and TypeScript throughout the product code.
- Web: React with Vite. Presentation uses Tailwind CSS utilities and the semantic theme in `apps/web/src/styles.css`; do not add component stylesheets or re-enable the default Tailwind palette.
- API: Fastify.
- Persistence: PostgreSQL with the latest stable Drizzle ORM release. Do not adopt Drizzle beta or release-candidate APIs without a new ADR.
- Authentication: Better Auth with email/password, Google, and GitHub.
- Realtime gameplay: server-authoritative WebSocket communication.
- Use runtime validation at every HTTP, WebSocket, provider, and environment boundary.
- Keep shared transport contracts in `packages/contracts`; do not import API implementation code into the web app.

## Non-negotiable domain rules

- A deterministic chess rules engine is the sole authority for position state, legal moves, and game results.
- An LLM may select only from the legal moves supplied to it. Never trust an LLM response as a legal move without validation.
- Models receive the same chess context: current FEN, complete PGN, side to move, and legal moves.
- Models must not receive Stockfish output, opponent commentary, or the opponent model identity.
- The canonical AI move format is UCI. Commentary is optional.
- Retry an invalid or illegal model response at most twice after the initial attempt; a third invalid result is a technical loss.
- Provider, network, authentication, quota, and timeout failures pause the game for user-directed retry. They are not technical losses.
- AI resignation and chess clocks are outside the MVP.
- Only one game may be in the `active` or `paused` state per authenticated user or guest session.

## Security and privacy

- Never write API keys, OAuth secrets, database URLs, session tokens, cookies, authorization headers, or decrypted credentials to logs or error payloads.
- Never store raw provider API keys in `localStorage`, `sessionStorage`, URLs, analytics, or client-side persisted state.
- Session-only keys may exist only in page memory and the minimum backend request scope required to call a provider.
- Persist provider keys only after explicit opt-in and only with authenticated encryption performed by the API before database insertion.
- Keep the credential-encryption key outside the database, in deployment secret storage.
- Treat prompts, provider responses, usernames, avatars, and game metadata as untrusted input at rendering and logging boundaries.
- Saved games are private in the MVP. Do not add public game or spectator endpoints without a product decision and authorization review.
- A guest may join a room but may not create one.

## Data and migration rules

- Prefer normalized relational tables for users, games, participants, moves, and model invocations.
- Use PostgreSQL `jsonb` only for bounded provider-specific configuration or metadata whose shape genuinely varies.
- Generate SQL migrations with Drizzle Kit, commit them, and review the generated SQL before applying it.
- Do not edit an already-applied migration. Add a forward migration.
- Keep external provider calls outside long-running database transactions.
- Use idempotency or optimistic concurrency for turn execution so duplicate requests cannot create duplicate moves.

## UI and accessibility

- Follow the dark, futuristic AI-arena direction without sacrificing chessboard readability.
- Build desktop-first, but keep all MVP game flows usable on mobile.
- Keep user-facing strings out of domain and transport code and route them through the localization layer.
- English is the initial locale. Do not hardcode layouts that prevent longer translated text.
- Support keyboard navigation, visible focus, reduced motion, sufficient contrast, and semantic controls.

## Verification

Run the smallest relevant checks while iterating and the full configured baseline before handing off a change:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

Add or update tests for behavior changes. Prioritize tests for chess-state transitions, move validation, provider normalization, retry classification, credential redaction, authorization, game privacy, WebSocket reconnection, and the three primary user flows.

Do not claim a command passed if it is not configured or was not run.

## Documentation and decisions

- Update the relevant canonical document only when its contract or instructions change, or a documented claim needs correction. A fix that restores already-documented behavior does not require a documentation edit.
- Keep implementation progress in `docs/roadmap.md`, updating it at milestones. Other documents link there instead of repeating status or per-PR implementation checkpoints.
- Add an ADR for a consequential, difficult-to-reverse decision; do not rewrite an accepted ADR as though the old decision never existed.
- Keep `docs/design-system/validation.md` limited to current coverage gaps and reference limitations; update it only when those change. Record per-change commands, results, and evidence in the change summary, PR, or CI, not as an accumulating documentation log.
- Keep docs concise and current. Link to a canonical explanation instead of duplicating it.

## MVP exclusions

Do not add ratings, tournaments, chat, social features, payments, public live spectators, time controls, arbitrary starting FEN positions, or AI custom prompts unless the product scope is explicitly changed.
