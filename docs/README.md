# Documentation

Neurochess Arena's documentation separates product requirements, system contracts, contributor instructions, and operator procedures. The [roadmap](roadmap.md) is the source for delivery status; specifications describe the current contract unless a section explicitly says otherwise.

## Start with a task

| Task                                       | Reading path                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Run the project locally                    | [Quick start](../README.md#quick-start) → [environment and contributor guide](development.md)                                     |
| Understand the product                     | [Product specification](product.md) → [design system](design-system.md)                                                           |
| Understand the system                      | [Architecture overview](architecture.md) → the relevant subsystem contract below                                                  |
| Integrate or change an endpoint            | [HTTP and WebSocket API](reference/http-api.md) → shared schemas in [packages/contracts](../packages/contracts/src/index.ts)      |
| Add or change a model adapter              | [Provider reference](reference/providers.md) → [provider architecture](architecture/providers.md)                                 |
| Change a browser flow                      | [Browser development](reference/browser.md) → [browser architecture](architecture/browser.md) → [design system](design-system.md) |
| Run tests or prepare release evidence      | [Testing guide](reference/testing.md) → [release acceptance](operations.md#mvp-release-acceptance)                                |
| Deploy or roll back a release              | [Production operations](operations.md)                                                                                            |
| Restore data or replace a failed host      | [Backup and recovery](recovery.md)                                                                                                |
| Rotate the saved-credential encryption key | [Credential rotation](credential-rotation.md)                                                                                     |
| Publish sources or distribute a build      | [Licensing policy](licensing.md) → [third-party notices](../THIRD_PARTY_NOTICES.md)                                               |
| Understand why a decision was made         | [ADR index](decisions/README.md)                                                                                                  |

## Subsystem contracts

The [architecture overview](architecture.md) owns component boundaries, the data map, and cross-system authority. Detailed contracts live in:

- [Browser routing and state](architecture/browser.md)
- [Games, commands, AI turns, and recovery](architecture/games.md)
- [Identity and credentials](architecture/identity-and-credentials.md)
- [Private rooms and realtime delivery](architecture/rooms.md)
- [Stockfish analysis](architecture/analysis.md)
- [Providers and telemetry](architecture/providers.md)

## Maintaining the documentation

Update the document that owns the rule, then link to it from other guides. Product behavior belongs in the product specification; API payloads and usage belong in the reference; operational commands belong in the runbooks. Keep implementation progress in the roadmap and execution evidence in the change, CI, or private release record.

Preserve accepted ADRs as historical decisions. A later decision can supersede or extend part of an earlier one; add a forward pointer so a reader can find the current contract. Routine dependency pins belong with their manifest and current reference, rather than in a rewritten historical decision.

Use relative Markdown links to repository files and heading anchors. When moving a section, update inbound links and keep the destination discoverable from this index. Run `npm run docs:check` for local links, heading anchors, npm commands, environment coverage, and API examples; `npm run format:check` verifies formatting. These checks are included in the normal verification workflow. They do not verify external websites or replace a review of the documented behavior.
