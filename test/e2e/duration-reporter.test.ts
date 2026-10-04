import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FullConfig, TestCase, TestResult } from "@playwright/test/reporter";
import { afterEach, describe, expect, it } from "vitest";

import DurationReporter from "./duration-reporter";

const directories: string[] = [];
const sentinel = "private-reporter-field-sentinel";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function reporter() {
  const directory = await mkdtemp(join(tmpdir(), "neurochess-durations-"));
  directories.push(directory);
  const outputDir = join(directory, "results");
  const instance = new DurationReporter();
  instance.onBegin({
    rootDir: directory,
    projects: [{ outputDir, metadata: { sentinel } }],
    metadata: { sentinel },
  } as unknown as FullConfig);
  return { instance, directory, outputFile: join(outputDir, "durations.json") };
}

function testCase(directory: string, project: string): TestCase {
  return {
    title: "creates a game",
    location: { file: join(directory, "games.spec.ts"), line: 12, column: 1 },
    parent: { project: () => ({ name: project, metadata: { sentinel } }) },
    repeatEachIndex: 0,
    expectedStatus: "passed",
    annotations: [{ type: "private", description: sentinel }],
  } as unknown as TestCase;
}

describe("browser duration report", () => {
  it("records attempts and project timings without copying credential-bearing diagnostics", async () => {
    const { instance, directory, outputFile } = await reporter();
    const result = {
      duration: 125,
      retry: 0,
      status: "failed",
      error: { message: sentinel, stack: sentinel },
      errors: [{ message: sentinel }],
      stdout: [sentinel],
      stderr: [Buffer.from(sentinel)],
      attachments: [{ name: sentinel, body: Buffer.from(sentinel), path: sentinel }],
      steps: [{ title: sentinel }],
    } as unknown as TestResult;
    instance.onTestEnd(testCase(directory, "desktop"), result);
    instance.onTestEnd(testCase(directory, "desktop"), { ...result, retry: 1, status: "passed" });
    instance.onTestEnd(testCase(directory, "mobile-touch"), {
      ...result,
      status: "skipped",
      duration: 0,
    });
    await instance.onEnd({
      status: "passed",
      startTime: new Date("2026-10-04T00:00:00Z"),
      duration: 400,
    });

    const text = await readFile(outputFile, "utf8");
    expect(text.includes(sentinel)).toBe(false);
    expect(text.includes(directory)).toBe(false);
    expect(JSON.parse(text)).toEqual({
      schemaVersion: 1,
      status: "passed",
      startedAt: "2026-10-04T00:00:00.000Z",
      durationMs: 400,
      attempts: [
        {
          project: "desktop",
          file: "games.spec.ts",
          line: 12,
          title: "creates a game",
          repeatEachIndex: 0,
          retry: 0,
          status: "failed",
          expectedStatus: "passed",
          durationMs: 125,
        },
        {
          project: "desktop",
          file: "games.spec.ts",
          line: 12,
          title: "creates a game",
          repeatEachIndex: 0,
          retry: 1,
          status: "passed",
          expectedStatus: "passed",
          durationMs: 125,
        },
        {
          project: "mobile-touch",
          file: "games.spec.ts",
          line: 12,
          title: "creates a game",
          repeatEachIndex: 0,
          retry: 0,
          status: "skipped",
          expectedStatus: "passed",
          durationMs: 0,
        },
      ],
    });
  });

  it.each(["failed", "timedout", "interrupted"] as const)(
    "retains the %s run status when no test finished",
    async (status) => {
      const { instance, outputFile } = await reporter();
      await instance.onEnd({ status, startTime: new Date("2026-10-04T00:00:00Z"), duration: 50 });
      expect(JSON.parse(await readFile(outputFile, "utf8"))).toMatchObject({
        status,
        durationMs: 50,
        attempts: [],
      });
    },
  );

  it("does not overwrite an existing report during collection-only runs", async () => {
    const { instance, directory, outputFile } = await reporter();
    instance.onTestEnd(testCase(directory, "desktop"), {
      duration: 125,
      retry: 0,
      status: "passed",
    } as TestResult);
    await instance.onEnd({
      status: "passed",
      startTime: new Date("2026-10-04T00:00:00Z"),
      duration: 200,
    });
    const original = await readFile(outputFile, "utf8");
    const collection = new DurationReporter();
    collection.onBegin({
      rootDir: directory,
      projects: [{ outputDir: join(directory, "results") }],
    } as unknown as FullConfig);
    await collection.onEnd({ status: "passed", startTime: new Date(), duration: 1 });
    expect(await readFile(outputFile, "utf8")).toBe(original);
  });
});
