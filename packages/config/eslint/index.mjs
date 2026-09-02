import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export function createEslintConfig({ rootDirectory }) {
  return tseslint.config(
    {
      ignores: [
        "**/coverage/**",
        "**/dist/**",
        "**/node_modules/**",
        "**/*.tsbuildinfo",
        "packages/database/drizzle/**",
        "test-fixtures/**",
      ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ["**/*.{js,mjs,cjs}"],
      languageOptions: {
        globals: globals.node,
      },
    },
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        parserOptions: {
          tsconfigRootDir: rootDirectory,
        },
      },
      rules: {
        "@typescript-eslint/consistent-type-imports": [
          "error",
          { fixStyle: "inline-type-imports" },
        ],
        "@typescript-eslint/no-import-type-side-effects": "error",
      },
    },
    {
      files: ["apps/api/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}"],
      languageOptions: {
        globals: globals.node,
      },
    },
    {
      files: ["apps/web/**/*.{ts,tsx}"],
      languageOptions: {
        globals: globals.browser,
      },
      plugins: {
        "react-hooks": reactHooks,
        "react-refresh": reactRefresh,
      },
      rules: {
        ...reactHooks.configs.flat.recommended.rules,
        ...reactRefresh.configs.vite.rules,
      },
    },
  );
}
