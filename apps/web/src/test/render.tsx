import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { i18n as I18nInstance } from "i18next";
import { type ReactElement, type ReactNode, StrictMode } from "react";
import { I18nextProvider } from "react-i18next";
import { createMemoryRouter, MemoryRouter, type RouteObject } from "react-router";
import { afterEach } from "vitest";

import { App } from "../app/App";
import { type AppRouterOptions, createAppRouter } from "../app/router";
import { consumeAuthEntry, readAuthEntry } from "../auth/navigation";
import { createWebI18n } from "../i18n";

export interface LocalizedRenderOptions extends Omit<RenderOptions, "wrapper"> {
  /** Defaults to a fresh English instance; pass one to exercise other resources. */
  readonly i18n?: I18nInstance;
}

export function renderLocalized(
  ui: ReactElement,
  { i18n = createWebI18n(), ...options }: LocalizedRenderOptions = {},
): RenderResult {
  return render(ui, {
    ...options,
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[window.location.pathname + window.location.search]}>
          {children}
        </MemoryRouter>
      </I18nextProvider>
    ),
  });
}

const routers = new Set<ReturnType<typeof createAppRouter>>();
afterEach(() => {
  for (const router of routers) router.dispose();
  routers.clear();
});

export function renderApp(
  options: AppRouterOptions,
  {
    i18n = createWebI18n(),
    strict = false,
    initialEntries,
    configureRoutes,
  }: {
    readonly i18n?: I18nInstance;
    readonly strict?: boolean;
    readonly initialEntries?: string[];
    readonly configureRoutes?: (routes: RouteObject[]) => void;
  } = {},
) {
  const router = createAppRouter(
    {
      ...options,
      authEntry:
        options.authEntry ??
        (initialEntries
          ? readAuthEntry(new URL(initialEntries.at(-1)!, "https://arena.invalid"))
          : consumeAuthEntry()),
    },
    initialEntries
      ? (routes) => {
          configureRoutes?.(routes);
          return createMemoryRouter(routes, { initialEntries });
        }
      : undefined,
  );
  routers.add(router);
  const element = (
    <I18nextProvider i18n={i18n}>
      <App router={router} />
    </I18nextProvider>
  );
  const result = render(strict ? <StrictMode>{element}</StrictMode> : element);
  return {
    ...result,
    router,
    unmount: () => {
      result.unmount();
      router.dispose();
      routers.delete(router);
    },
  };
}
