import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { expect, it, vi } from "vitest";

import { RouteNavigation } from "./route-navigation";
import { RouteEffects } from "./RouteEffects";

it("stops restoring an unreachable Back position after a bounded wait", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("scrollY", 0);
  let maximum = 1000;
  const scroll = vi.fn(({ top = 0 }: ScrollToOptions) => {
    window.scrollY = Math.min(top, maximum);
  });
  vi.stubGlobal("scrollTo", scroll);
  const navigation = new RouteNavigation();
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <RouteEffects navigation={navigation} pendingLabel="Opening page" />
            <Outlet />
          </>
        ),
        children: [
          { path: "/history", element: <main>History</main> },
          { path: "/other", element: <main>Other</main> },
        ],
      },
    ],
    { initialEntries: ["/history"] },
  );
  const view = render(<RouterProvider router={router} />);
  try {
    window.scrollTo({ top: 600 });
    fireEvent.scroll(window);
    await act(() => router.navigate("/other"));
    await act(() => vi.advanceTimersByTimeAsync(20));
    maximum = 100;
    await act(() => router.navigate(-1));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(window.scrollY).toBe(100);
    await act(() => vi.advanceTimersByTimeAsync(2500));
    scroll.mockClear();
    const update = document.createElement("div");
    await act(async () => {
      document.body.append(update);
    });
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(scroll).not.toHaveBeenCalled();
    update.remove();
  } finally {
    view.unmount();
    router.dispose();
    vi.useRealTimers();
  }
});

it.each([false, true])("records scroll after cancelled Back (batched: %s)", async (batched) => {
  vi.stubGlobal("scrollY", 0);
  vi.stubGlobal("scrollTo", ({ top = 0 }: ScrollToOptions) => {
    window.scrollY = top;
  });
  const loading = Promise.withResolvers<null>();
  const navigation = new RouteNavigation();
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <RouteEffects navigation={navigation} pendingLabel="Opening page" />
            <Outlet />
          </>
        ),
        children: [
          { path: "/slow", loader: () => loading.promise, element: <main>Slow page</main> },
          { path: "/history", element: <main>History</main> },
          { path: "/other", element: <main>Other page</main> },
        ],
      },
    ],
    { initialEntries: ["/slow", "/history"] },
  );
  const unsubscribe = router.subscribe((state) => {
    navigation.departing(state.navigation.location ?? state.location);
  });
  const view = render(<RouterProvider router={router} />);
  try {
    const historyKey = router.state.location.key;
    window.scrollTo({ top: 600 });
    if (batched) {
      await act(async () => {
        void router.navigate(-1);
        await router.navigate(1);
      });
    } else {
      await act(async () => {
        void router.navigate(-1);
      });
      expect(router.state.navigation.state).toBe("loading");
      await act(() => router.navigate(1));
    }
    expect(router.state.navigation.state).toBe("idle");
    expect(router.state.location.key).toBe(historyKey);

    window.scrollTo({ top: 900 });
    fireEvent.scroll(window);
    await act(() => router.navigate("/other"));
    await waitFor(() => expect(window.scrollY).toBe(0));
    await act(() => router.navigate(-1));
    await waitFor(() => expect(window.scrollY).toBe(900));
  } finally {
    view.unmount();
    unsubscribe();
    router.dispose();
    loading.resolve(null);
  }
});
