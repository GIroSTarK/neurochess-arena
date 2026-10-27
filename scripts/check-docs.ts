import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aiControllerRequestSchema,
  aiGameConfigurationSchema,
  aiTurnRequestSchema,
  guestSessionRequestSchema,
  lifecycleCommandSchema,
  modelDiscoveryRequestSchema,
} from "@neurochess/contracts";

const ignoredDirectories = new Set([
  ".git",
  ".idea",
  ".postgres-data",
  ".tmp",
  ".vite",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "playwright-report",
  "test-results",
  "vendor",
]);

function markdownFiles(root: string): string[] {
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  }
  visit(root);
  const rebuild = join(root, "apps/web/vendor/stockfish/REBUILD.md");
  if (existsSync(rebuild)) files.push(rebuild);
  return files.sort();
}

function proseLines(markdown: string): string[] {
  let fence: string | undefined;
  return markdown.split(/\r?\n/).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      if (
        marker?.[1] !== undefined &&
        marker[1].startsWith(fence.slice(0, 1)) &&
        marker[1].length >= fence.length &&
        marker[2]?.trim() === ""
      ) {
        fence = undefined;
      }
      return "";
    }
    if (marker?.[1] !== undefined) {
      fence = marker[1];
      return "";
    }
    return line;
  });
}

function headingAnchors(lines: string[]): Set<string> {
  const anchors = new Set<string>();
  for (const line of lines) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const slug = heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .split(/(`+[^`]*`+)/g)
      .map((part) =>
        part.startsWith("`")
          ? part
          : part.replace(/(^|[\s(])(_{1,2})(.+?)\2(?=$|[\s).,:;!?])/g, "$1$3"),
      )
      .join("")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "")
      .replace(/ /g, "-");
    let anchor = slug;
    let suffix = 0;
    while (anchors.has(anchor)) anchor = `${slug}-${++suffix}`;
    anchors.add(anchor);
  }
  return anchors;
}

function linkTargets(line: string): string[] {
  const inline = [...line.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
  const reference = /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/.exec(line);
  if (reference !== null) inline.push(reference[1] ?? reference[2] ?? "");
  return inline;
}

function environmentErrors(root: string, developmentLines: string[]): string[] {
  const source = readFileSync(join(root, "apps/api/src/env.ts"), "utf8");
  // Delimit the one schema rather than evaluating startup code or matching unrelated keys.
  // If its construction changes, fail closed so this extractor is reviewed with it.
  const schema =
    /const apiEnvironmentSchema = z\s*\.object\(\{([\s\S]*?)\n\s{2}\}\)\s*\.superRefine\(/.exec(
      source,
    )?.[1];
  const keys =
    schema === undefined
      ? []
      : [...schema.matchAll(/^ {4}([A-Z][A-Z0-9_]*):/gm)].flatMap((match) => match[1] ?? []);
  if (keys.length === 0) {
    return [
      "apps/api/src/env.ts: cannot locate the apiEnvironmentSchema object before superRefine",
    ];
  }
  const documented = new Set(
    developmentLines.flatMap((line) => {
      const firstCell = /^\s*\|([^|]+)\|/.exec(line)?.[1] ?? "";
      return [...firstCell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((match) => match[1]);
    }),
  );
  return keys
    .filter((key) => !documented.has(key))
    .map(
      (key) => `docs/development.md: API environment variable is missing from the table: ${key}`,
    );
}

export function checkDocumentation(root: string): { filesChecked: number; errors: string[] } {
  const files = markdownFiles(root);
  const errors: string[] = [];
  const scripts: unknown = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: unknown }
  ).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new Error("package.json must contain a scripts object");
  }
  const documents = new Map(files.map((path) => [path, proseLines(readFileSync(path, "utf8"))]));
  const anchors = new Map([...documents].map(([path, lines]) => [path, headingAnchors(lines)]));
  for (const path of files) {
    const name = relative(root, path).replaceAll("\\", "/");
    const lines = documents.get(path) ?? [];
    for (const [index, line] of lines.entries()) {
      for (const destination of linkTargets(line)) {
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) continue;
        let decoded: string;
        try {
          decoded = decodeURIComponent(destination);
        } catch {
          errors.push(`${name}:${index + 1}: malformed local link: ${destination}`);
          continue;
        }
        const [pathname = "", fragment] = decoded.split("#", 2);
        const targetPath = pathname.split("?", 1)[0] ?? "";
        const target =
          targetPath === ""
            ? path
            : resolve(
                targetPath.startsWith("/") ? root : dirname(path),
                targetPath.replace(/^\//, ""),
              );
        if (!existsSync(target)) {
          errors.push(`${name}:${index + 1}: local link target does not exist: ${destination}`);
        } else if (fragment && target.endsWith(".md")) {
          const targetAnchors =
            anchors.get(target) ?? headingAnchors(proseLines(readFileSync(target, "utf8")));
          if (!targetAnchors.has(fragment)) {
            errors.push(`${name}:${index + 1}: heading anchor does not exist: ${destination}`);
          }
        }
      }
    }
    // Commands in fenced examples are executable instructions even though their Markdown is literal.
    for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
      for (const match of line.matchAll(/\bnpm[ \t]+run(?:-script)?[ \t]+([\w:-]+)/g)) {
        const commandTail = line.slice(match.index + match[0].length).split(/[`;&|]/, 1)[0] ?? "";
        if (
          /(?:^|\s)(?:--workspace(?:s)?(?:=|\s|$)|-w(?:=|\s)|--prefix(?:=|\s))/.test(commandTail)
        ) {
          continue;
        }
        const script = match[1] ?? "";
        if (!Object.hasOwn(scripts, script)) {
          errors.push(`${name}:${index + 1}: root npm script does not exist: ${script}`);
        }
      }
    }
  }
  errors.push(...environmentErrors(root, documents.get(join(root, "docs/development.md")) ?? []));
  return { filesChecked: files.length, errors };
}

const exampleSchemas = {
  bootstrapGuest: guestSessionRequestSchema,
  discoverModels: modelDiscoveryRequestSchema,
  createAiGame: aiGameConfigurationSchema,
  createAiHumanGame: aiGameConfigurationSchema,
  acquireController: aiControllerRequestSchema,
  heartbeat: aiControllerRequestSchema,
  activeTurn: aiTurnRequestSchema,
  pause: lifecycleCommandSchema,
  resume: lifecycleCommandSchema,
  pausedStep: aiTurnRequestSchema,
  recoverPause: lifecycleCommandSchema,
  acquireRecoveredController: aiControllerRequestSchema,
  resumeRecoveredGame: lifecycleCommandSchema,
  abort: lifecycleCommandSchema,
};

export function checkDocumentationExamples(examples: unknown): string[] {
  const file = "docs/examples/ai-lifecycle.json";
  if (typeof examples !== "object" || examples === null || Array.isArray(examples)) {
    return [`${file}: expected a named request payload object`];
  }
  const payloads = examples as Record<string, unknown>;
  const errors = Object.keys(payloads)
    .filter((name) => !Object.hasOwn(exampleSchemas, name))
    .map((name) => `${file}: no transport schema assigned to ${name}`);
  for (const [name, schema] of Object.entries(exampleSchemas)) {
    const parsed = schema.safeParse(payloads[name]);
    if (!parsed.success) {
      const paths = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "root")),
      ];
      errors.push(`${file}: invalid ${name} payload at ${paths.join(", ")}`);
    }
  }
  return errors;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, "..");
  const result = checkDocumentation(root);
  result.errors.push(
    ...checkDocumentationExamples(
      JSON.parse(readFileSync(join(root, "docs/examples/ai-lifecycle.json"), "utf8")),
    ),
  );
  if (result.errors.length > 0) {
    process.stderr.write(`${result.errors.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Documentation checks passed for ${result.filesChecked} Markdown files and ${Object.keys(exampleSchemas).length} request examples.\n`,
    );
  }
}
