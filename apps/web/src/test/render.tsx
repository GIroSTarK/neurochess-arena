import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { i18n as I18nInstance } from "i18next";
import type { ReactElement, ReactNode } from "react";
import { I18nextProvider } from "react-i18next";

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
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    ),
  });
}
