import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

const testFiles = ["**/*.test.{ts,tsx}", "**/test/**/*.{ts,tsx}"];

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
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      // Side effects, Node built-ins, packages, then parent and sibling imports as their own groups.
      plugins: { "simple-import-sort": simpleImportSort },
      rules: {
        "simple-import-sort/imports": [
          "error",
          { groups: [["^\\u0000"], ["^node:"], ["^@?\\w"], ["^\\.\\."], ["^\\./"]] },
        ],
      },
    },
    {
      files: ["**/*.{js,mjs,cjs}"],
      ...tseslint.configs.disableTypeChecked,
      languageOptions: {
        globals: globals.node,
      },
    },
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        parserOptions: {
          tsconfigRootDir: rootDirectory,
          // Application and package sources belong to their own projects; tests, helpers, and
          // root configuration files belong to tsconfig.tests.json.
          project: [
            "./tsconfig.tests.json",
            "./apps/*/tsconfig.json",
            "./packages/*/tsconfig.json",
          ],
        },
      },
      rules: {
        "@typescript-eslint/consistent-type-imports": [
          "error",
          { fixStyle: "inline-type-imports" },
        ],
        "@typescript-eslint/no-import-type-side-effects": "error",
        // Arrow shorthand that forwards a void call is idiomatic in handlers and listeners.
        "@typescript-eslint/no-confusing-void-expression": [
          "error",
          { ignoreArrowShorthand: true },
        ],
        // void is the natural type argument for Promise.withResolvers and event callbacks.
        "@typescript-eslint/no-invalid-void-type": "off",
        // Fastify plugins, React act callbacks, and mocked interfaces carry contractual async
        // signatures whether or not their bodies await.
        "@typescript-eslint/require-await": "off",
        // Numbers may join strings; nullish, boolean, and object operands stay forbidden.
        "@typescript-eslint/restrict-plus-operands": [
          "error",
          {
            allowAny: false,
            allowBoolean: false,
            allowNullish: false,
            allowNumberAndString: true,
            allowRegExp: false,
          },
        ],
        "@typescript-eslint/restrict-template-expressions": [
          "error",
          {
            allowAny: false,
            allowBoolean: false,
            allowNever: false,
            allowNullish: false,
            allowNumber: true,
            allowRegExp: false,
          },
        ],
      },
    },
    {
      files: testFiles,
      rules: {
        // Tests assert that values exist and remove fields to build invalid payloads.
        "@typescript-eslint/no-non-null-assertion": "off",
        "@typescript-eslint/no-dynamic-delete": "off",
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
