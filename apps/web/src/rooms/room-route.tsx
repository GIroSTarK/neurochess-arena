import type { RoomView } from "@neurochess/contracts";
import { useLayoutEffect } from "react";
import { useRevalidator } from "react-router";

import type { PublicIdentity } from "../api/identity";
import { createRoomGameApi } from "../api/room-game-client";
import { createRoomRealtime } from "../api/room-realtime-client";
import { PageContext } from "../routing/route-context";
import { useGameRouteController } from "../routing/use-game-route-controller";
import { RouteNotice } from "../shell/route-notice";

import { RoomController } from "./controller";
import { RoomScreen } from "./room-screen";

export function RoomRoute({
  apiBaseUrl,
  identity,
  room,
  entryData,
  accessLost,
  takeInvitation,
}: {
  readonly apiBaseUrl: string;
  readonly identity: PublicIdentity;
  readonly room: RoomView | null;
  readonly entryData: unknown;
  readonly accessLost: boolean;
  readonly takeInvitation?: ((gameId: string) => string | null) | undefined;
}) {
  const revalidator = useRevalidator();
  const { controller, stopped, departing, retry } = useGameRouteController(
    "arena",
    () =>
      new RoomController(
        createRoomGameApi(apiBaseUrl, identity),
        createRoomRealtime(apiBaseUrl, identity),
      ),
    (owner) => {
      if (room) owner.enter(room, takeInvitation?.(room.snapshot.gameId));
      else if (accessLost) owner.revokeAccess();
      else owner.unavailable();
    },
    identity.signal,
    {
      data: entryData,
      refresh: () => {
        void revalidator.revalidate();
      },
    },
  );
  useLayoutEffect(() => {
    if (accessLost) controller.revokeAccess();
  }, [controller, accessLost]);
  if (stopped) return <RouteNotice kind={departing ? "loading" : "stopped"} onRetry={retry} />;
  return (
    <PageContext value="rooms">
      <RoomScreen
        controller={controller}
        onRetry={retry}
        identity={identity}
        apiBaseUrl={apiBaseUrl}
      />
    </PageContext>
  );
}
