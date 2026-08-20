# ADR-0003: AI provider adapter and normalized move contract

**Status:** Accepted  
**Date:** 2026-08-15

## Context

The MVP supports OpenAI, Anthropic, Google, and OpenRouter. These providers differ in authentication, model discovery, parameter names, structured output, error formats, usage reporting, and pricing metadata. Game-domain code should not branch on provider-specific response shapes.

## Decision

- Place each provider behind a shared server-side adapter.
- Adapters expose normalized model discovery and move-request operations.
- Model discovery comes from the provider through the backend rather than a hardcoded model list.
- A normalized model descriptor reports provider capabilities so the UI displays only supported parameters.
- Every provider receives the same chess information: current FEN, complete PGN, model color, and legal moves.
- Providers do not receive Stockfish analysis, opponent commentary, or opponent identity.
- The required response field is a UCI move. Viewer commentary is optional.
- Missing commentary is accepted and displayed with a neutral fallback.
- Invalid schema or illegal moves receive two automatic retries after the initial attempt. A third invalid response is a technical loss.
- Provider/network/auth/quota/timeout failures pause the game for user retry and are not technical losses.
- AI resignation is not supported in the MVP.
- Normalize usage and latency. Estimate cost only when reliable usage and pricing metadata are available.

## Consequences

- Chess orchestration and UI contracts remain stable as provider SDKs change.
- Provider differences and model capabilities require explicit adapter tests.
- Dynamic model lists may contain models that cannot satisfy the move contract; the product must communicate capability or runtime failures clearly.
- Reproducibility requires persisting the provider, model identifier, effective supported parameters, normalized result, and retry attempts for each move.
- Cost values are estimates and may be unavailable.

## Alternatives considered

### Call providers directly from the browser

Rejected because browser support differs, provider behavior would leak into the UI, credential controls would be weaker, and normalization/redaction would be duplicated.

### Maintain a fixed model allowlist

Rejected for the MVP product requirement. A future compatibility cache or warning list may complement, but not replace, provider model discovery.

### Include Stockfish suggestions in prompts

Rejected because the flagship experience is comparison of LLM chess decisions, not comparison of how models repeat engine advice.
