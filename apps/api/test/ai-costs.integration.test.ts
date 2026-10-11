import type { AiGameConfiguration } from "@neurochess/contracts";
import { games, modelInvocations } from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createGameService } from "../src/games/service.js";
import { createOpenAiAdapter } from "../src/providers/openai.js";

import { access, control, turnCommand } from "./ai-turn-helpers.js";
import { ApiHarness } from "./helpers.js";
import { type HttpStep, mockHttp } from "./providers/mock-http.js";
import { openAiCatalog, openAiResponse } from "./providers/openai-fixtures.js";

const modelId = "gpt-4.1-mini-2025-04-14";
const configuration: AiGameConfiguration = {
  mode: "ai_vs_human",
  seats: {
    white: { type: "ai", provider: "openai", modelId, parameters: {} },
    black: { type: "human" },
  },
};
function billed(text = '{"move":"e2e4"}') {
  return {
    ...openAiResponse(text),
    model: modelId,
    service_tier: "default",
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      total_tokens: 140,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}
const harness = new ApiHarness();
afterEach(() => harness.dispose());

async function setup(steps: HttpStep[]) {
  const api = await harness.createApi();
  const owner = await harness.guest(api);
  const http = mockHttp([Response.json(openAiCatalog([modelId])), ...steps]);
  const service = createGameService(api.repository, {
    nodeEnv: "test",
    sandboxEnabled: true,
    aiAdapters: { openai: createOpenAiAdapter(http.transport) },
  });
  const { snapshot } = await service.createAi(owner.principal, configuration);
  await service.controller(owner.principal, {
    gameId: snapshot.gameId,
    controllerId: snapshot.gameId,
    expectedVersion: snapshot.version,
    action: "acquire",
  });
  return { api, service, principal: owner.principal, http, snapshot };
}

describe("durable private invocation estimates", () => {
  it("persists invalid and accepted attempts atomically, deduplicates and reads without provider calls", async () => {
    const { api, service, principal, http, snapshot } = await setup([
      Response.json(billed('{"move":"e2e5"}')),
      Response.json(billed()),
    ]);
    const command = turnCommand(snapshot);
    const accepted = await service.aiTurn(principal, command, access());
    expect(accepted.moves).toHaveLength(1);
    const read = await service.invocations(principal, snapshot.gameId);
    expect(read.turns[0]).toMatchObject({
      invalidOutputCount: 1,
      acceptedMovePly: 1,
      attempts: [
        { outcome: "model_invalid", cost: { status: "estimated", amount: "0.000095000000" } },
        { outcome: "accepted", cost: { status: "estimated", amount: "0.000095000000" } },
      ],
    });
    await expect(service.aiTurn(principal, command, access())).rejects.toMatchObject({
      code: "GAME_CONFLICT",
    });
    expect(await service.invocations(principal, snapshot.gameId)).toEqual(read);
    expect(http.requests).toHaveLength(3);
    const terminal = await service.lifecycle(principal, control(accepted, "abort"));
    expect((await service.replay(principal, snapshot.gameId)).snapshot).toEqual(terminal);
    expect((await service.invocations(principal, snapshot.gameId)).turns).toEqual(read.turns);
    expect(http.requests).toHaveLength(3);
    expect(
      JSON.stringify(
        await api.repository.read((reader) => reader.getModelInvocations(snapshot.gameId)),
      ),
    ).not.toContain(access().apiKey);
    const outsider = await harness.guest(api);
    await expect(service.invocations(outsider.principal, snapshot.gameId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("keeps known failed usage and preserves a provider pause without invalid-output budget", async () => {
    const { service, principal, snapshot } = await setup([
      Response.json({ ...billed(), status: "failed", error: { code: "server_error" } }),
    ]);
    const paused = await service.aiTurn(principal, turnCommand(snapshot), access());
    expect(paused.state).toBe("paused");
    expect(await service.invocations(principal, snapshot.gameId)).toMatchObject({
      turns: [
        {
          invalidOutputCount: 0,
          attempts: [
            { outcome: "provider_error", cost: { status: "estimated", amount: "0.000095000000" } },
          ],
        },
      ],
    });
  });

  it("pins pricing before dispatch and finalizes a late interrupted result only as discarded", async () => {
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Response>();
    const { api, service, principal, snapshot } = await setup([
      () => {
        entered.resolve();
        return reply.promise;
      },
    ]);
    const pending = service.aiTurn(principal, turnCommand(snapshot), access());
    const settled = pending.catch((error: unknown) => error);
    await entered.promise;
    const [inFlight] = await api.repository.read((reader) =>
      reader.getModelInvocations(snapshot.gameId),
    );
    expect(inFlight).toMatchObject({
      pricingVersion: "2026-10-11.1",
      pricingRates: { inputTokens: "0.40" },
      costAmount: null,
    });
    const paused = await service.lifecycle(principal, control(snapshot, "pause"));
    expect(await service.invocations(principal, snapshot.gameId)).toMatchObject({
      turns: [
        {
          attempts: [
            { outcome: "interrupted", cost: { status: "unavailable", reason: "dispatch_unknown" } },
          ],
        },
      ],
    });
    reply.resolve(Response.json(billed()));
    expect(await settled).toMatchObject({ code: "GAME_CONFLICT" });
    expect(await service.snapshot(principal, snapshot.gameId)).toEqual(paused);
    const after = await service.invocations(principal, snapshot.gameId);
    expect(after).toMatchObject({
      turns: [
        {
          invalidOutputCount: 0,
          attempts: [
            { outcome: "discarded", cost: { status: "estimated", amount: "0.000095000000" } },
          ],
        },
      ],
    });
    const [stored] = await api.repository.read((reader) =>
      reader.getModelInvocations(snapshot.gameId),
    );
    expect(
      await api.repository.write((tx) =>
        tx.finishModelInvocation(
          stored!.id,
          stored!.reservationId,
          {
            outcome: "discarded",
            errorCode: null,
            errorReason: null,
            durationMs: 1,
            usageReported: false,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            commentary: null,
            billingUsage: null,
            costAmount: "999.000000000000",
            costUnavailableReason: null,
          },
          true,
        ),
      ),
    ).toBe(false);
    expect(await service.invocations(principal, snapshot.gameId)).toEqual(after);
  });

  it("keeps a valid move when pricing is incomplete and preserves historical unknown records", async () => {
    const response = billed();
    const { api, service, principal, snapshot } = await setup([
      Response.json({ ...response, usage: { input_tokens: 100, output_tokens: 40 } }),
    ]);
    const accepted = await service.aiTurn(principal, turnCommand(snapshot), access());
    expect(accepted.moves).toHaveLength(1);
    expect(await service.invocations(principal, snapshot.gameId)).toMatchObject({
      turns: [
        {
          attempts: [
            {
              outcome: "accepted",
              usage: { inputTokens: 100, outputTokens: 40, totalTokens: null },
              cost: { status: "unavailable", reason: "usage_incomplete" },
            },
          ],
        },
      ],
    });
    const [row] = await api.repository.read((reader) =>
      reader.getModelInvocations(snapshot.gameId),
    );
    await api.database.db
      .update(modelInvocations)
      .set({
        pricingVersion: null,
        pricingSource: null,
        pricingCheckedAt: null,
        pricingRates: null,
        pricingUnavailableReason: "legacy_record",
        billingUsage: null,
        costAmount: null,
        costUnavailableReason: "legacy_record",
      })
      .where(eq(modelInvocations.id, row!.id));
    expect(await service.invocations(principal, snapshot.gameId)).toMatchObject({
      turns: [{ attempts: [{ cost: { status: "unavailable", reason: "legacy_record" } }] }],
    });
    await api.database.db.delete(games).where(eq(games.id, snapshot.gameId));
    expect(
      await api.database.db.select().from(modelInvocations).where(eq(modelInvocations.id, row!.id)),
    ).toEqual([]);
  });

  it("does not recreate deleted games or cost records when a billed result arrives late", async () => {
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Response>();
    const { api, service, principal, snapshot } = await setup([
      () => {
        entered.resolve();
        return reply.promise;
      },
    ]);
    const pending = service
      .aiTurn(principal, turnCommand(snapshot), access())
      .catch((error: unknown) => error);
    await entered.promise;
    const [attempt] = await api.repository.read((reader) =>
      reader.getModelInvocations(snapshot.gameId),
    );
    await api.database.db.delete(games).where(eq(games.id, snapshot.gameId));
    reply.resolve(Response.json(billed()));
    expect(await pending).toMatchObject({ code: "NOT_FOUND" });
    expect(
      await api.database.db
        .select()
        .from(modelInvocations)
        .where(eq(modelInvocations.id, attempt!.id)),
    ).toEqual([]);
  });
});
