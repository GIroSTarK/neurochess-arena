import { createInstance, type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import { en } from "./en";

export function createWebI18n(): I18nInstance {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
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
