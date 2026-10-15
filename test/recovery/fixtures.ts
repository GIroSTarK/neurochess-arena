import { randomUUID } from "node:crypto";

import {
  gameDetailsSchema,
  gameSnapshotSchema,
  roomIssuedResponseSchema,
} from "@neurochess/contracts";
import { expect } from "vitest";

import { aiMatch, control, turnCommand } from "../../apps/api/test/ai-turn-helpers.js";
import { analysisSample } from "../../apps/api/test/analysis-helpers.js";
import { command, FOOLS_MATE, type TestApi } from "../../apps/api/test/helpers.js";
import type { RoomSocketHarness } from "../../apps/api/test/room-socket-helpers.js";

export async function fixtures(harness: RoomSocketHarness, api: TestApi) {
  const owner = await harness.account(api);
  const peer = await harness.account(api);
  const outsider = await harness.account(api);
  const recovering = await harness.account(api);
  const roomOwner = await harness.account(api);
  const guest = await harness.guest(api);
  const credentialId = randomUUID();
  const providerKey = `synthetic-recovery-${randomUUID()}`;
  expect(
    (
      await harness.post(api, owner.cookie, "/credentials", {
        credentialId,
        provider: "openai",
        label: "Restore fixture",
        apiKey: providerKey,
        save: true,
      })
    ).statusCode,
  ).toBe(201);
  let { snapshot: solo } = await harness.createGame(api, owner.cookie);
  expect(
    (
      await harness.post(api, owner.cookie, `/games/${solo.gameId}/controller`, {
        gameId: solo.gameId,
        controllerId: solo.gameId,
        expectedVersion: solo.version,
        action: "acquire",
      })
    ).statusCode,
  ).toBe(200);
  for (let ply = 0; ply < 4; ply++) {
    const response = await harness.post(api, owner.cookie, `/games/${solo.gameId}/ai-turn`, {
      ...turnCommand(solo),
      ...(ply % 2 === 0 ? { credentialId } : { apiKey: providerKey }),
    });
    expect(response.statusCode).toBe(200);
    solo = gameSnapshotSchema.parse(response.json());
  }
  expect(solo.state).toBe("completed");
  expect(
    (
      await harness.post(api, owner.cookie, `/games/${solo.gameId}/analysis`, {
        samples: [analysisSample(solo, 4)],
      })
    ).statusCode,
  ).toBe(200);
  const unfinished = (await harness.createGame(api, recovering.cookie)).snapshot;
  const guestCreated = await harness.post(api, guest.cookie, "/games", aiMatch);
  expect(guestCreated.statusCode).toBe(201);
  const guestInitial = gameDetailsSchema.parse(guestCreated.json()).snapshot;
  const guestAborted = await harness.post(
    api,
    guest.cookie,
    `/games/${guestInitial.gameId}/lifecycle`,
    control(guestInitial, "abort"),
  );
  expect(guestAborted.statusCode).toBe(200);
  const guestSolo = gameSnapshotSchema.parse(guestAborted.json());

  async function room(ownerCookie: string, peerCookie: string) {
    const operation = await harness.operation(api, ownerCookie);
    const issued = roomIssuedResponseSchema.parse(
      (
        await harness.post(api, ownerCookie, "/rooms", {
          operationId: operation.operationId,
          ownerColor: "white",
        })
      ).json(),
    );
    return (await harness.join(api, peerCookie, issued.invitation!, randomUUID())).snapshot;
  }
  let shared = await room(owner.cookie, peer.cookie);
  for (const [index, move] of FOOLS_MATE.entries()) {
    const response = await harness.post(
      api,
      index % 2 ? peer.cookie : owner.cookie,
      `/games/${shared.gameId}/moves`,
      command(shared, move),
    );
    expect(response.statusCode).toBe(200);
    shared = gameSnapshotSchema.parse(response.json());
  }
  for (const [cookie, score] of [
    [owner.cookie, 24],
    [peer.cookie, -42],
  ] as const) {
    expect(
      (
        await harness.post(api, cookie, `/games/${shared.gameId}/analysis`, {
          samples: [{ ...analysisSample(shared, 4), score: { kind: "cp", value: score } }],
        })
      ).statusCode,
    ).toBe(200);
  }
  expect(
    (
      await harness.post(api, owner.cookie, `/games/${shared.gameId}/delete`, {
        gameId: shared.gameId,
        confirm: true,
      })
    ).statusCode,
  ).toBe(200);
  let active = await room(roomOwner.cookie, guest.cookie);
  const moved = await harness.post(
    api,
    roomOwner.cookie,
    `/games/${active.gameId}/moves`,
    command(active, "e2e4"),
  );
  expect(moved.statusCode).toBe(200);
  active = gameSnapshotSchema.parse(moved.json());
  return {
    owner,
    peer,
    outsider,
    recovering,
    roomOwner,
    guest,
    credentialId,
    providerKey,
    solo,
    unfinished,
    guestSolo,
    shared,
    active,
  };
}
