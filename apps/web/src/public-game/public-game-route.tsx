import { useMemo, useState } from "react";
import { useParams, useRouteLoaderData } from "react-router";

import { PublicPage } from "../app/public-page";
import { AuthRoute } from "../auth/auth-route";
import { useRequiredAccount } from "../auth/context";
import { useRouteAuthEntry } from "../auth/use-route-auth-entry";
import { MatchRoute } from "../match/match-route";
import type { MatchRouteData } from "../match/route-data";
import { RoomRoute } from "../rooms/room-route";
import type { RoomEntryFeature } from "../rooms/route-data";
import { useAppRoute } from "../routing/route-context";

import type { PublicGameRouteData } from "./route-data";

export function PublicGameRoute({ rooms }: { readonly rooms?: RoomEntryFeature | undefined }) {
  const { authEntry } = useAppRoute();
  const entry = useRouteAuthEntry(authEntry);
  if (entry.verified || entry.error) return <AuthRoute kind="sign-in" />;
  return (
    <PublicPage>
      <PublicGameMode rooms={rooms} />
    </PublicPage>
  );
}

function isMatchData(result: PublicGameRouteData | null | undefined): result is MatchRouteData {
  // Preserve the runtime-owned object so identity invalidation clears the feature's data too.
  return !!result && result.data?.entry?.kind !== "room";
}

function PublicGameMode({ rooms }: { readonly rooms?: RoomEntryFeature | undefined }) {
  const { apiBaseUrl } = useAppRoute();
  const account = useRequiredAccount();
  const identity = useMemo(
    () => account.controller.identity(),
    // A revision replaces authority; ordinary profile/revalidation renders do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account.controller, account.state.revision],
  );
  const { gameId } = useParams();
  const gameData = useRouteLoaderData<PublicGameRouteData>("arena-game");
  const setupData = useRouteLoaderData<PublicGameRouteData>("arena-entry");
  const result = gameData ?? setupData;
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
        identity={identity}
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
      identity={identity}
      result={isMatchData(result) ? result : null}
    />
  );
}
