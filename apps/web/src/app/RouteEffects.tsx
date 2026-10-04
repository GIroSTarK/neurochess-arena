import { useEffect, useLayoutEffect, useRef } from "react";
import { NavigationType, useLocation, useNavigation, useNavigationType } from "react-router";

import type { RouteNavigation } from "./route-navigation";

export function RouteEffects({
  navigation,
  pendingLabel,
}: {
  readonly navigation: RouteNavigation;
  readonly pendingLabel: string;
}) {
  const location = useLocation();
  const pending = useNavigation();
  const action = useNavigationType();
  const previous = useRef(location);
  const positions = useRef(new Map<string, { left: number; top: number }>());
  useEffect(() => {
    const original = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = original;
    };
  }, []);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = location;
    if (
      before.key === location.key ||
      (before.pathname === location.pathname && before.search === location.search)
    ) {
      return;
    }
    if (navigation.takeFocusHandoff(location.pathname)) return;
    if (action === NavigationType.Pop) {
      const position = positions.current.get(location.key) ?? { left: 0, top: 0 };
      let frame = 0;
      const stop = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        for (const event of ["pointerdown", "keydown", "wheel", "touchstart"]) {
          window.removeEventListener(event, stop);
        }
      };
      const restore = () => {
        window.scrollTo({ ...position, behavior: "instant" });
        if (
          Math.abs(window.scrollY - position.top) < 1 &&
          Math.abs(window.scrollX - position.left) < 1
        ) {
          stop();
        }
      };
      // A committed route can still be waiting for feature-owned reads to fill its page.
      const observer = new MutationObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(restore);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      for (const event of ["pointerdown", "keydown", "wheel", "touchstart"]) {
        window.addEventListener(event, stop, { passive: true });
      }
      frame = requestAnimationFrame(restore);
      return stop;
    }
    const frame = requestAnimationFrame(() => {
      const main = document.querySelector<HTMLElement>("main");
      if (main?.contains(document.activeElement)) return;
      (
        document.querySelector<HTMLElement>('main h1[tabindex="-1"]') ??
        document.querySelector<HTMLElement>("main")
      )?.focus({ preventScroll: true });
      window.scrollTo({ left: 0, top: 0, behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [location, action, navigation]);
  useEffect(() => {
    const record = () => {
      const cache = positions.current;
      cache.set(location.key, { left: window.scrollX, top: window.scrollY });
      const oldest = cache.keys().next().value;
      if (cache.size > 50 && oldest) cache.delete(oldest);
    };
    window.addEventListener("scroll", record, { passive: true });
    return () => window.removeEventListener("scroll", record);
  }, [location.key]);
  return pending.state !== "idle" ? (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-10 rounded-control border border-control-border bg-surface px-4 py-3 text-label text-text"
    >
      {pendingLabel}
    </div>
  ) : null;
}
