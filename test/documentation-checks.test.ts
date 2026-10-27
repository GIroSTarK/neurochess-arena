import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import examples from "../docs/examples/ai-lifecycle.json";
import { checkDocumentation, checkDocumentationExamples } from "../scripts/check-docs.js";

const temporaryRoots: string[] = [];

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "neurochess-docs-"));
  temporaryRoots.push(root);
  for (const [path, contents] of Object.entries({
    "package.json": JSON.stringify({ scripts: { lint: "eslint .", "test:unit": "vitest run" } }),
    "apps/api/src/env.ts": [
      "const unrelated = { NOT_AN_ENVIRONMENT_VARIABLE: true };",
      "const apiEnvironmentSchema = z",
      "  .object({",
      "    API_HOST: z.string(),",
      "    API_PORT: z.number(),",
      "  })",
      "  .superRefine(() => {});",
      "throw new Error('The environment source must never be executed');",
    ].join("\n"),
    "docs/development.md":
      "# Development\n\n| Variable | Purpose |\n| --- | --- |\n| `API_HOST`, `API_PORT` | API |\n",
    ...files,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("documentation drift checks", () => {
  it("reports missing local files with the referring file and line", () => {
    const root = repository({ "README.md": "# Project\n\n[Missing](docs/missing.md)\n" });

    expect(checkDocumentation(root).errors).toEqual([
      "README.md:3: local link target does not exist: docs/missing.md",
    ]);
  });

  it("rejects a stale anchor after a heading is renamed", () => {
    const root = repository({
      "README.md": "[Setup](docs/setup.md#local-setup)",
      "docs/setup.md": "# Setup\n\n## Updated setup\n",
    });

    expect(checkDocumentation(root).errors).toEqual([
      "README.md:1: heading anchor does not exist: docs/setup.md#local-setup",
    ]);
  });

  it("resolves inline heading formatting, encoded paths, and duplicate heading suffixes", () => {
    const root = repository({
      "README.md":
        "[First](docs/setup%20guide.md#api_env--setup)\n[Repeat](docs/setup%20guide.md#api_env--setup-1)",
      "docs/setup guide.md": "# `API_ENV` — **Setup**\n\n# `API_ENV` — **Setup**\n",
    });

    expect(checkDocumentation(root).errors).toEqual([]);
  });

  it("rejects a duplicate-heading anchor when the duplicate was removed", () => {
    const root = repository({
      "README.md": "[Repeat](docs/setup.md#setup-1)",
      "docs/setup.md": "# Setup\n",
    });

    expect(checkDocumentation(root).errors).toEqual([
      "README.md:1: heading anchor does not exist: docs/setup.md#setup-1",
    ]);
  });

  it("removes underscore emphasis while preserving underscores inside code headings", () => {
    const root = repository({
      "README.md": "[Heading](docs/setup.md#bold-italic-_api_env_)",
      "docs/setup.md": "# __Bold__ _italic_ `_API_ENV_`\n",
    });

    expect(checkDocumentation(root).errors).toEqual([]);
  });

  it("ignores fenced links and shell comments when finding Markdown headings", () => {
    const root = repository({
      "README.md": "[Shell](docs/setup.md#shell-example)",
      "docs/setup.md": [
        "# Setup",
        "~~~bash",
        "# Shell example",
        "[Not a link](missing.md)",
        "npm run lint",
        "~~~",
        "````markdown",
        "```",
        "# Shell example",
        "````",
      ].join("\n"),
    });

    expect(checkDocumentation(root).errors).toEqual([
      "README.md:1: heading anchor does not exist: docs/setup.md#shell-example",
    ]);
  });

  it("checks reference links and local fragments without contacting external links", () => {
    const root = repository({
      "README.md":
        "# Project\n[Local](#project)\n[External](https://example.invalid/no-file#heading)\n[Guide][setup]\n\n[setup]: docs/setup.md#missing\n",
      "docs/setup.md": "# Setup\n",
    });

    expect(checkDocumentation(root).errors).toEqual([
      "README.md:6: heading anchor does not exist: docs/setup.md#missing",
    ]);
  });

  it("checks root npm commands in prose and fences while excluding workspace commands", () => {
    const root = repository({
      "README.md":
        "Run `npm run missing`.\n```sh\nnpm run misspelled\nnpm run test:unit\nnpm run package-only --workspace @neurochess/api\n```\n",
    });

    expect(checkDocumentation(root).errors).toEqual([
      "README.md:1: root npm script does not exist: missing",
      "README.md:3: root npm script does not exist: misspelled",
    ]);
  });

  it("finds first-party Markdown recursively and includes Stockfish rebuild instructions", () => {
    const root = repository({
      "packages/example/README.md": "[Missing](missing.md)",
      "apps/web/vendor/stockfish/REBUILD.md": "[Missing](missing.md)",
      "apps/web/vendor/stockfish/source/README.md": "[Upstream](missing.md)",
      "node_modules/upstream/README.md": "[Upstream](missing.md)",
      "apps/web/dist/README.md": "[Generated](missing.md)",
      ".git/README.md": "[Internal](missing.md)",
    });

    expect(checkDocumentation(root).errors).toEqual([
      "apps/web/vendor/stockfish/REBUILD.md:1: local link target does not exist: missing.md",
      "packages/example/README.md:1: local link target does not exist: missing.md",
    ]);
  });

  it("requires each actual API environment key in a table, not only prose", () => {
    const root = repository({
      "docs/development.md":
        "# Development\n\n| Variable | Purpose |\n| --- | --- |\n| `API_HOST` | API |\n\nThe API uses `API_PORT`.\n",
    });

    expect(checkDocumentation(root).errors).toEqual([
      "docs/development.md: API environment variable is missing from the table: API_PORT",
    ]);
  });

  it("fails explicitly when the environment schema can no longer be extracted", () => {
    const root = repository({ "apps/api/src/env.ts": "const schema = { API_HOST: true };" });

    expect(checkDocumentation(root).errors).toEqual([
      "apps/api/src/env.ts: cannot locate the apiEnvironmentSchema object before superRefine",
    ]);
  });
});

describe("documented request examples", () => {
  it("accepts the checked-in lifecycle walkthrough payloads", () => {
    expect(checkDocumentationExamples(examples)).toEqual([]);
  });

  it("rejects a lifecycle payload that no longer follows the public transport schema", () => {
    expect(
      checkDocumentationExamples({
        ...examples,
        activeTurn: { ...examples.activeTurn, expectedVersion: -1 },
      }),
    ).toEqual(["docs/examples/ai-lifecycle.json: invalid activeTurn payload at expectedVersion"]);
  });

  it("rejects unmapped examples instead of silently leaving them unchecked", () => {
    expect(checkDocumentationExamples({ ...examples, unknownRequest: {} })).toEqual([
      "docs/examples/ai-lifecycle.json: no transport schema assigned to unknownRequest",
    ]);
  });
});
