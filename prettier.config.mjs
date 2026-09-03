import { prettierConfig } from "@neurochess/config/prettier";

export default {
  ...prettierConfig,
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindStylesheet: "./apps/web/src/styles.css",
  tailwindFunctions: ["cx"],
};
