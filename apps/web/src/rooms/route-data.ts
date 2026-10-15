import { chessColorSchema, gameIdSchema, type RoomView } from "@neurochess/contracts";
import { replace } from "react-router";
import { z } from "zod";

import { RequestRateLimitFailure } from "../api/failures";
import { createRoomApi, RoomFailure } from "../api/room-client";
import type { AppRouteContext } from "../routing/route-context";
import {
  protectedLoader,
  routeAction,
  selfPostRevalidation,
  strictFormIntent,
} from "../routing/route-data";
import type { PublicAccess, ScopedRouteData } from "../routing/route-runtime";
import { gameHref, parseGameId } from "../routing/route-urls";

import { RoomEntryMemory, type RoomIssue } from "./entry-memory";
import { parseInvitation, type RoomInvitationEntry } from "./invitation";

export type RoomEntryData = ScopedRouteData<{
  access: PublicAccess;
  expectedIdentity: string;
  existingGameId: string | null;
}>;

const sequence = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative());
const expectation = {
  generation: sequence,
  expectedIdentity: z.union([z.uuid(), z.literal("guest"), z.literal("none")]),
};
const ownerCommand = {
  ...expectation,
  gameId: gameIdSchema,
  expectedVersion: sequence,
  confirm: z.literal("true"),
};
const intentSchema = z.discriminatedUnion("intent", [
  z.strictObject({ intent: z.literal("create"), ownerColor: chessColorSchema, ...expectation }),
  ...(["resolve", "join", "retry-create", "retry-join"] as const).map((intent) =>
    z.strictObject({ intent: z.literal(intent), ...expectation }),
  ),
  ...(["replace", "revoke", "close"] as const).map((intent) =>
    z.strictObject({ intent: z.literal(intent), ...ownerCommand }),
  ),
  z.strictObject({ intent: z.literal("refresh-room"), gameId: gameIdSchema, ...expectation }),
]);
type Pending =
  | { kind: "create"; operationId: string; ownerColor: "white" | "black" }
  | { kind: "join"; invitation: string; commandId: string; bootstrapped: boolean }
  | { kind: "owner" };

function issueFor(error: unknown, owner = false): RoomIssue {
  if (error instanceof RequestRateLimitFailure) return "limited";
  if (!(error instanceof RoomFailure) || error.kind !== "api") return "uncertain";
  switch (error.code) {
    case "GAME_CONFLICT":
      return owner ? "synchronize" : "occupied";
    case "UNAUTHORIZED":
    case "PROFILE_REQUIRED":
      return "access";
    case "ROOM_ACCOUNT_UNVERIFIED":
      return "unverified";
    case "ROOM_SELF_JOIN":
      return "self";
    case "RATE_LIMITED":
      return "limited";
    case "ROOM_OPERATION_UNAVAILABLE":
    case "ROOM_OPERATION_CONFLICT":
      return "operation";
    case "INTERNAL_SERVER_ERROR":
      return "uncertain";
    default:
      return "unavailable";
  }
}

export function roomRouteData(
  {
    apiBaseUrl,
    runtime,
    navigation,
  }: Pick<AppRouteContext, "apiBaseUrl" | "runtime" | "navigation">,
  bootstrap?: RoomInvitationEntry,
  joinPath = "/rooms/join",
) {
  const memory = new RoomEntryMemory(bootstrap?.read() ?? null);
  bootstrap?.retire();
  let generation: number | null = null;
  let pending: Pending | null = null;
  let handoff: string | null = null;
  let location: string | null = null;
  let invitationHandoff = false;
  const clear = () => {
    pending = null;
    handoff = null;
    invitationHandoff = false;
    bootstrap?.retire();
    memory.clear();
  };
  const unsubscribeInvitation = bootstrap?.subscribe(() => {
    const invitation = bootstrap.read();
    clear();
    if (invitation) {
      invitationHandoff = true;
      memory.setInput(invitation);
    }
  });
  const unsubscribeIdentity = runtime.account.subscribe(() => {
    if (generation !== null && generation !== runtime.account.getSnapshot().revision) {
      generation = runtime.account.getSnapshot().revision;
      clear();
    }
  });
  const unsubscribeNavigation = navigation.subscribe((destination) => {
    const next = destination.pathname + destination.search;
    if (next === location) {
      invitationHandoff = false;
      return;
    }
    const adopting =
      (handoff !== null && next === gameHref("arena", handoff)) ||
      (invitationHandoff && next === "/rooms/join");
    if (location !== null && !adopting) clear();
    invitationHandoff = false;
    location = next;
  });
  window.addEventListener("pagehide", clear);

  const acceptRoom = (room: RoomView, invitation: string | null = null) => {
    memory.update({
      room,
      issuedInvitation: invitation,
      input: "",
      resolution: null,
      issue: null,
      pending: null,
    });
    pending = null;
  };
  const loader = (kind: "setup" | "join" | "waiting") =>
    protectedLoader(async ({ request, params }): Promise<RoomEntryData | null> => {
      const id = kind === "waiting" ? parseGameId(params.gameId) : null;
      if (kind === "waiting" && !id) return null;
      const lifetime = memory.signal;
      const resolved = await runtime.resolvePublicIdentity(request.signal, true);
      generation = resolved.generation;
      const { access, identity } = resolved;
      const signal = AbortSignal.any([
        request.signal,
        lifetime,
        ...(identity ? [identity.signal] : []),
      ]);
      const cancelled = () => signal.aborted;
      const result = (existingGameId: string | null = null) =>
        runtime.result(resolved.generation, {
          access,
          expectedIdentity: identity?.expectedAccount ?? "none",
          existingGameId,
        });
      if (cancelled()) return null;
      try {
        if (kind === "join") {
          const input = memory.getSnapshot().input;
          const invitation = parseInvitation(input, window.location.origin, joinPath);
          if (invitation) {
            const response = await createRoomApi(apiBaseUrl).resolve(invitation, signal);
            if (!cancelled() && memory.getSnapshot().input === input) {
              memory.update({ resolution: response.status });
            }
          }
        } else if (identity && kind === "waiting" && id) {
          if (handoff === id && memory.getSnapshot().room?.snapshot.gameId === id) {
            handoff = null;
          } else {
            const room = await createRoomApi(apiBaseUrl, { identity }).read(id, signal);
            if (!cancelled()) acceptRoom(room);
          }
        } else if (identity?.intent === "account") {
          const existing = await createRoomApi(apiBaseUrl, { identity }).unfinished(signal);
          return cancelled() ? null : result(existing);
        }
        return cancelled() ? null : result();
      } catch (error) {
        if (cancelled()) return null;
        memory.update({ issue: issueFor(error), room: null });
        return result();
      }
    });

  const action = routeAction(runtime, async ({ request }, scope): Promise<Response | null> => {
    if (memory.getSnapshot().busy) return null;
    const input =
      request.method === "POST" ? strictFormIntent(await request.formData(), intentSchema) : null;
    if (memory.getSnapshot().busy) return null;
    if (!input) {
      memory.update({ issue: "invalid" });
      return null;
    }
    const lifetime = memory.signal;
    memory.update({ busy: true });
    const owner =
      input.intent === "close" || input.intent === "replace" || input.intent === "revoke";
    try {
      const resolved = await scope.resolveIdentity(true);
      generation ??= resolved.generation;
      const { identity } = resolved;
      const signal = AbortSignal.any([
        scope.signal,
        lifetime,
        ...(identity ? [identity.signal] : []),
      ]);
      const cancelled = () => signal.aborted;
      if (cancelled()) return null;
      if (
        resolved.generation !== input.generation ||
        (identity?.expectedAccount ?? "none") !== input.expectedIdentity
      ) {
        memory.update({ issue: "access" });
        return null;
      }
      if (input.intent === "resolve") {
        if (pending) return null;
        const invitation = parseInvitation(
          memory.getSnapshot().input,
          window.location.origin,
          joinPath,
        );
        if (!invitation) {
          memory.update({ issue: "invalid", resolution: null });
          return null;
        }
        const response = await createRoomApi(apiBaseUrl).resolve(invitation, signal);
        if (!cancelled()) memory.update({ resolution: response.status, issue: null });
        return null;
      }
      if (
        !identity ||
        ((input.intent === "create" || input.intent === "retry-create" || owner) &&
          identity.intent !== "account")
      ) {
        memory.update({ issue: "access" });
        return null;
      }
      const api = createRoomApi(apiBaseUrl, { identity });
      if (input.intent === "create" || input.intent === "retry-create") {
        if (input.intent === "create") {
          if (pending) return null;
          const operation = await api.operation(signal);
          if (cancelled()) return null;
          pending = {
            kind: "create",
            operationId: operation.operationId,
            ownerColor: input.ownerColor,
          };
        }
        if (pending?.kind !== "create") {
          memory.update({ issue: "operation" });
          return null;
        }
        memory.update({ pending: "create", issue: null });
        const issued = await api.create(
          { operationId: pending.operationId, ownerColor: pending.ownerColor },
          signal,
        );
        if (cancelled()) return null;
        acceptRoom(issued.room, issued.invitation);
        handoff = issued.room.snapshot.gameId;
        return replace(gameHref("arena", handoff));
      }
      if (input.intent === "join" || input.intent === "retry-join") {
        if (input.intent === "join") {
          if (pending) return null;
          const invitation = parseInvitation(
            memory.getSnapshot().input,
            window.location.origin,
            joinPath,
          );
          if (!invitation) {
            memory.update({ issue: "invalid" });
            return null;
          }
          pending = {
            kind: "join",
            invitation,
            commandId: crypto.randomUUID(),
            bootstrapped: identity.intent !== "guest",
          };
        }
        if (pending?.kind !== "join") {
          memory.update({ issue: "invalid" });
          return null;
        }
        memory.update({ pending: "join", issue: null });
        const command = pending;
        if (!command.bootstrapped) {
          await api.bootstrap(signal);
          if (cancelled()) return null;
          command.bootstrapped = true;
        }
        const room = await api.join(
          { invitation: command.invitation, commandId: command.commandId },
          signal,
        );
        if (cancelled()) return null;
        acceptRoom(room);
        handoff = room.snapshot.gameId;
        return replace(gameHref("arena", handoff));
      }
      if (input.intent === "refresh-room") {
        const room = await api.read(input.gameId, signal);
        if (!cancelled()) acceptRoom(room);
        return null;
      }
      if (owner && "gameId" in input && "expectedVersion" in input) {
        if (pending) return null;
        pending = { kind: "owner" };
        memory.update({ pending: "owner", issue: null });
        const command = {
          gameId: input.gameId,
          expectedVersion: input.expectedVersion,
          commandId: crypto.randomUUID(),
        };
        if (input.intent === "close") {
          await api.close(command, signal);
          if (cancelled()) return null;
          memory.update({ issuedInvitation: null });
          const room = await api.read(input.gameId, signal);
          if (!cancelled()) acceptRoom(room);
        } else {
          const issued = await api.invitation({ ...command, action: input.intent }, signal);
          if (!cancelled()) acceptRoom(issued.room, issued.invitation);
        }
      }
      return null;
    } catch (error) {
      if (scope.signal.aborted || lifetime.aborted) return null;
      const issue = issueFor(error, owner);
      if (owner) memory.update({ issuedInvitation: null });
      if (
        issue !== "uncertain" &&
        issue !== "synchronize" &&
        !((pending?.kind === "join" || pending?.kind === "create") && issue === "limited")
      ) {
        pending = null;
        memory.update({ pending: null });
      }
      if (issue === "access") clear();
      memory.update({ issue });
      return null;
    } finally {
      if (!lifetime.aborted) memory.update({ busy: false });
    }
  });

  return {
    memory,
    peekHandoff(gameId: string) {
      return handoff === gameId ? memory.getSnapshot().room : null;
    },
    takeInvitation: (gameId: string) => {
      if (handoff !== gameId) return null;
      const invitation = memory.getSnapshot().issuedInvitation;
      const lifetime = memory.signal;
      // StrictMode repeats the mounted owner's first effect before the microtask
      // boundary. Both setups adopt the same issuance; no later entry can reuse it.
      queueMicrotask(() => {
        if (!lifetime.aborted && handoff === gameId) clear();
      });
      return invitation;
    },
    setup: { loader: loader("setup"), action, shouldRevalidate: selfPostRevalidation("/rooms") },
    join: { loader: loader("join"), action, shouldRevalidate: selfPostRevalidation("/rooms/join") },
    waiting: {
      loader: loader("waiting"),
      action,
      shouldRevalidate: (args: Parameters<ReturnType<typeof selfPostRevalidation>>[0]) =>
        args.formMethod === "POST" ? false : args.defaultShouldRevalidate,
    },
    dispose() {
      unsubscribeInvitation?.();
      bootstrap?.dispose();
      unsubscribeIdentity();
      unsubscribeNavigation();
      window.removeEventListener("pagehide", clear);
      clear();
    },
  };
}

export type RoomEntryFeature = ReturnType<typeof roomRouteData>;
