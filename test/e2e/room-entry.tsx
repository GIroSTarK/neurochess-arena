import "@fontsource-variable/inter";
import "@fontsource-variable/orbitron";
import "../../apps/web/src/styles.css";

import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import { createBrowserRouter, Outlet, useFetcher, useLoaderData } from "react-router";
import { RouterProvider } from "react-router/dom";

import { createAuthApi } from "../../apps/web/src/api/auth-client";
import { AccountAccess } from "../../apps/web/src/auth/account-access";
import { AccountApplication } from "../../apps/web/src/auth/account-application";
import { AuthRoute } from "../../apps/web/src/auth/auth-route";
import { authAction, publicLoader } from "../../apps/web/src/auth/route-data";
import { i18n } from "../../apps/web/src/i18n";
import { ProfileRoute } from "../../apps/web/src/profile/profile-route";
import { accountAction, profileLoader } from "../../apps/web/src/profile/route-data";
import { consumeRoomInvitation } from "../../apps/web/src/rooms/invitation";
import { RoomEntryScreen } from "../../apps/web/src/rooms/room-entry-screen";
import { RoomWaitingScreen } from "../../apps/web/src/rooms/room-waiting-screen";
import { type RoomEntryData, roomRouteData } from "../../apps/web/src/rooms/route-data";
import { RouteContext } from "../../apps/web/src/routing/route-context";
import { RouteEffects } from "../../apps/web/src/routing/route-effects";
import { RouteNavigation } from "../../apps/web/src/routing/route-navigation";
import { RouteRuntime } from "../../apps/web/src/routing/route-runtime";
import { AppShell } from "../../apps/web/src/shell/app-shell";
import { TextLink } from "../../apps/web/src/ui/text-link";

import { API_ORIGIN } from "./environment";

const basename = "/__test__";
const invitation = consumeRoomInvitation(basename + "/rooms/join");
const runtime = new RouteRuntime(createAuthApi(API_ORIGIN));
const navigation = new RouteNavigation();
const context = { apiBaseUrl: API_ORIGIN, sandboxEnabled: false, runtime, navigation };
const feature = roomRouteData(context, invitation, basename + "/rooms/join");

function RoomLeaf({ mode }: { readonly mode: "setup" | "join" | "waiting" }) {
  const { t } = useTranslation();
  const entry = useLoaderData<RoomEntryData | null>();
  const account = useSyncExternalStore(runtime.account.subscribe, runtime.account.getSnapshot);
  const state = useSyncExternalStore(feature.memory.subscribe, feature.memory.getSnapshot);
  const fetcher = useFetcher();
  const data = entry?.generation === account.revision ? entry.data : null;
  const submit = (intent: string, fields: Record<string, string>) => {
    if (!data) return;
    void fetcher.submit(
      {
        intent,
        ...fields,
        generation: String(entry!.generation),
        expectedIdentity: data.expectedIdentity,
      },
      { method: "POST" },
    );
  };
  return (
    <AppShell
      mainId="room-entry"
      skipLabel={t("app.skipLink")}
      context={<AccountAccess />}
      footer={null}
      announcement=""
      navigation={
        <>
          <TextLink to="/rooms">Private rooms</TextLink>
          <TextLink to="/rooms/join">Join</TextLink>
          <TextLink to="/">Leave entry</TextLink>
        </>
      }
    >
      <p className="pt-4 text-label text-warning">
        Test harness · Room entry only · Gameplay handoff
      </p>
      {!data ? (
        <p role="alert">{t("rooms.errors.access")}</p>
      ) : mode !== "waiting" ? (
        <RoomEntryScreen
          key={entry!.generation + mode}
          mode={mode}
          access={data.access}
          existingGameId={data.existingGameId}
          memory={feature.memory}
          onSubmit={submit}
        />
      ) : state.room &&
        (state.room.state !== "waiting" || state.room.snapshot.state !== "paused") ? (
        <p role="status">Room handoff: {state.room.snapshot.state}</p>
      ) : (
        <RoomWaitingScreen key={entry!.generation} memory={feature.memory} onSubmit={submit} />
      )}
    </AppShell>
  );
}
function Root() {
  return (
    <RouteContext value={context}>
      <RouteEffects navigation={navigation} pendingLabel={i18n.t("routing.pending")} />
      <Outlet />
    </RouteContext>
  );
}
const router = createBrowserRouter(
  [
    {
      Component: Root,
      hydrateFallbackElement: <p>Loading room entry test harness…</p>,
      children: [
        {
          Component: AccountApplication,
          children: [
            { path: "rooms", ...feature.setup, element: <RoomLeaf mode="setup" /> },
            { path: "rooms/join", ...feature.join, element: <RoomLeaf mode="join" /> },
            { path: "games/:gameId", ...feature.waiting, element: <RoomLeaf mode="waiting" /> },
            {
              path: "account",
              loader: profileLoader(runtime),
              action: accountAction(runtime),
              Component: ProfileRoute,
            },
            ...(["sign-in", "sign-up", "verify", "forgot-password", "reset-password"] as const).map(
              (kind) => ({
                path: `auth/${kind}`,
                loader: publicLoader(runtime, false),
                action: authAction(runtime, kind),
                element: <AuthRoute kind={kind} />,
              }),
            ),
          ],
        },
        {
          index: true,
          element: (
            <main>
              <h1>Outside room entry</h1>
              <TextLink to="/rooms">Private rooms</TextLink>
            </main>
          ),
        },
      ],
    },
  ],
  { basename },
);

const observe = () => {
  const destination = router.state.navigation.location ?? router.state.location;
  const relative = { ...destination, pathname: destination.pathname.slice(basename.length) || "/" };
  runtime.navigating(relative);
  navigation.departing(relative);
  if (router.state.navigation.state === "idle") navigation.arrived(relative);
};
const unsubscribeRouter = router.subscribe(observe);
observe();
const unsubscribeIdentity = runtime.account.subscribe(() => {
  queueMicrotask(() => {
    if (
      router.state.navigation.state !== "idle" ||
      router.state.revalidation !== "idle" ||
      runtime.account.transitionPending
    ) {
      return;
    }
    if (
      Object.values(router.state.loaderData).some(
        (value: unknown) =>
          value &&
          typeof value === "object" &&
          "generation" in value &&
          "data" in value &&
          (value.generation !== runtime.account.getSnapshot().revision || value.data === null),
      )
    ) {
      void router.revalidate();
    }
  });
});
const root = createRoot(document.getElementById("root")!);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    unsubscribeIdentity();
    unsubscribeRouter();
    feature.dispose();
    router.dispose();
    runtime.dispose();
  });
}
root.render(
  <I18nextProvider i18n={i18n}>
    <RouterProvider router={router} />
  </I18nextProvider>,
);
