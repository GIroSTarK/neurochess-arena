import { useState } from "react";
import { useParams, useRouteLoaderData } from "react-router";

import { useRequiredAccount } from "../auth/context";
import { RoomRoute } from "../rooms/room-route";
import type { RoomEntryFeature } from "../rooms/route-data";
import { useAppRoute } from "../routing/route-context";

import { MatchRoute } from "./match-route";
import type { ArenaRouteData } from "./route-data";

export function MatchRouteLayout({ rooms }: { readonly rooms?: RoomEntryFeature | undefined }) {
  const { apiBaseUrl } = useAppRoute();
  const account = useRequiredAccount();
  const { gameId } = useParams();
  const result = useRouteLoaderData<ArenaRouteData>("arena-game");
  const entry = result?.data?.entry;
  const [owner, setOwner] = useState({ gameId, room: entry?.kind === "room" });
  // A failed revalidation cannot replace the mounted game owner. Only a new target or
  // an authorized mode projection selects a different feature lifetime.
  const roomMode =
    entry?.kind === "room" ||
    (owner.gameId === gameId && owner.room && entry?.kind === "unavailable");
  if (owner.gameId !== gameId || owner.room !== roomMode) setOwner({ gameId, room: roomMode });
  if (roomMode) {
    return (
      <RoomRoute
        key={account.state.revision}
        apiBaseUrl={apiBaseUrl}
        identity={account.controller.identity()}
        room={entry.kind === "room" ? entry.room : null}
        accessLost={entry.kind === "unavailable" && entry.code === "access"}
        entryData={result}
        takeInvitation={rooms?.takeInvitation}
      />
    );
  }
  return (
    <MatchRoute
      key={account.state.revision}
      apiBaseUrl={apiBaseUrl}
      identity={account.controller.identity()}
    />
  );
}
