import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

interface Attempt {
  project: string;
  file: string;
  line: number;
  title: string;
  repeatEachIndex: number;
  retry: number;
  status: TestResult["status"];
  expectedStatus: TestCase["expectedStatus"];
  durationMs: number;
}

export default class DurationReporter implements Reporter {
  private rootDir = "";
  private outputFile: string | undefined;
  private attempts: Attempt[] = [];

  onBegin(config: FullConfig) {
    this.rootDir = config.rootDir;
    this.outputFile = join(config.projects[0]!.outputDir, "durations.json");
  }

  onTestEnd(test: TestCase, result: TestResult) {
    // Keep an allowlist: errors, output, steps, attachments and config may contain credentials.
    this.attempts.push({
      project: test.parent.project()!.name,
      file: relative(this.rootDir, test.location.file).split(sep).join("/"),
      line: test.location.line,
      title: test.title,
      repeatEachIndex: test.repeatEachIndex,
      retry: result.retry,
      status: result.status,
      expectedStatus: test.expectedStatus,
      durationMs: result.duration,
    });
  }

  async onEnd(result: FullResult) {
    if (!this.outputFile || (result.status === "passed" && this.attempts.length === 0)) return;
    await mkdir(dirname(this.outputFile), { recursive: true });
    await writeFile(
      this.outputFile,
      JSON.stringify(
        {
          schemaVersion: 1,
          status: result.status,
          startedAt: result.startTime.toISOString(),
          durationMs: result.duration,
          attempts: this.attempts,
        },
        null,
        2,
      ) + "\n",
    );
  }

  printsToStdio() {
    return false;
  }
}
