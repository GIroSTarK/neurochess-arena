import { createInstance, type i18n as I18nInstance } from "i18next";

import { en } from "./en";

/**
 * A synchronously initialized English instance. The app supplies it through an
 * I18nextProvider, so no global react-i18next instance is registered; tests render under the
 * same provider.
 */
export function createWebI18n(): I18nInstance {
  const instance = createInstance();
  void instance.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en } },
    defaultNS: "translation",
    initAsync: false,
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: false },
  });
  return instance;
}

export const i18n: I18nInstance = createWebI18n();
