import type * as databaseModule from "@neurochess/database";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const { close, createDatabase, readFile, reconcileRestoredDatabase, stat } = vi.hoisted(() => {
  const close = vi.fn();
  return {
    close,
    createDatabase: vi.fn(() => ({ close })),
    readFile: vi.fn(),
    reconcileRestoredDatabase: vi.fn(),
    stat: vi.fn(),
  };
});

vi.mock("node:fs/promises", () => ({ readFile, stat }));
vi.mock("@neurochess/database", async (importOriginal) => ({
  ...(await importOriginal<typeof databaseModule>()),
  createDatabase,
  reconcileRestoredDatabase,
}));

const baseUrl =
  "postgresql://restore-user:recovery-password-canary@database.example.com:5432/nc_restore_0123456789abcdef0123456789abcdef";
const verifiedUrl = `${baseUrl}?sslmode=verify-full`;
const manifestFile = "recovery-manifest.json";
const manifest = {
  confirm: "reconcile-isolated-restore-v1",
  accounts: [],
  history: [],
  credentials: [],
  guests: [],
  invitations: [],
  invalidateSessions: true,
};
const underlyingError = new Error(`underlying-error-canary: ${verifiedUrl}`);
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let stdoutWrite: MockInstance<typeof process.stdout.write>;
let stderrWrite: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  process.argv = ["node", "reconcile-cli.js", manifestFile];
  process.exitCode = undefined;
  vi.stubEnv("DATABASE_URL", verifiedUrl);
  vi.stubEnv("RECOVERY_ISOLATED", "true");
  vi.resetModules();
  vi.resetAllMocks();
  stat.mockResolvedValue({ size: 1024 });
  readFile.mockResolvedValue(JSON.stringify(manifest));
  createDatabase.mockReturnValue({ close });
  reconcileRestoredDatabase.mockResolvedValue(undefined);
  close.mockResolvedValue(undefined);
  stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
});

function expectFailureOutput(): void {
  expect(stdoutWrite).not.toHaveBeenCalled();
  expect(stderrWrite).toHaveBeenCalledExactlyOnceWith(
    '{"event":"restore_reconciliation","status":"failure"}\n',
  );
  expect(process.exitCode).toBe(1);
}

async function expectRejectedBeforeConnection(): Promise<void> {
  await import("./reconcile-cli.js");
  expect(createDatabase).not.toHaveBeenCalled();
  expect(reconcileRestoredDatabase).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expectFailureOutput();
}

describe("reconciliation CLI admission", () => {
  it.each([
    { name: "missing URL", value: undefined },
    { name: "empty URL", value: "" },
    { name: "malformed URL", value: "malformed-recovery-url-canary" },
    { name: "non-PostgreSQL URL", value: verifiedUrl.replace("postgresql:", "https:") },
    { name: "missing sslmode", value: baseUrl },
    { name: "disabled TLS", value: `${baseUrl}?sslmode=disable` },
    { name: "unverified TLS", value: `${baseUrl}?sslmode=require` },
    { name: "certificate-only verification", value: `${baseUrl}?sslmode=verify-ca` },
    { name: "disabled verification", value: `${baseUrl}?sslmode=no-verify` },
    { name: "duplicate sslmode", value: `${verifiedUrl}&sslmode=verify-full` },
    { name: "trailing conflicting sslmode", value: `${verifiedUrl}&sslmode=disable` },
    {
      name: "leading conflicting sslmode",
      value: `${baseUrl}?sslmode=disable&sslmode=verify-full`,
    },
    { name: "disabled ssl override", value: `${verifiedUrl}&ssl=0` },
    { name: "enabled ssl override", value: `${verifiedUrl}&ssl=true` },
    { name: "empty ssl override", value: `${verifiedUrl}&ssl=` },
    { name: "enabled libpq compatibility", value: `${verifiedUrl}&uselibpqcompat=true` },
    { name: "disabled libpq compatibility", value: `${verifiedUrl}&uselibpqcompat=false` },
    { name: "empty libpq compatibility", value: `${verifiedUrl}&uselibpqcompat=` },
    { name: "ordinary database", value: verifiedUrl.replace(/nc_restore_[a-f0-9]+/, "arena") },
    { name: "short recovery suffix", value: verifiedUrl.replace("0123456789abcdef", "") },
    {
      name: "non-hex recovery suffix",
      value: verifiedUrl.replace("0123456789abcdef", "g123456789abcdef"),
    },
  ])("rejects $name before constructing a database", async ({ value }) => {
    vi.stubEnv("DATABASE_URL", value);
    await expectRejectedBeforeConnection();
  });

  it.each([undefined, "", "false", "TRUE"])(
    "rejects isolation confirmation %s before constructing a database",
    async (value) => {
      vi.stubEnv("RECOVERY_ISOLATED", value);
      await expectRejectedBeforeConnection();
    },
  );

  it.each([
    { name: "missing manifest", args: [] },
    { name: "empty manifest path", args: [""] },
    { name: "extra argument", args: [manifestFile, "extra-argument-canary"] },
  ])("rejects $name before constructing a database", async ({ args }) => {
    process.argv = ["node", "reconcile-cli.js", ...args];
    await expectRejectedBeforeConnection();
  });

  it("rejects an oversized manifest before constructing a database", async () => {
    stat.mockResolvedValue({ size: 1_048_577 });
    await expectRejectedBeforeConnection();
  });

  it("redacts filesystem admission errors before constructing a database", async () => {
    stat.mockRejectedValue(underlyingError);
    await expectRejectedBeforeConnection();
  });
});

describe("reconciliation CLI execution", () => {
  it.each([
    { name: "verified TLS", url: verifiedUrl, size: 1024 },
    {
      name: "mounted CA",
      url: `${verifiedUrl}&sslrootcert=/run/secrets/postgres-ca.pem`,
      size: 1024,
    },
    { name: "maximum manifest size", url: verifiedUrl, size: 1_048_576 },
  ])("reconciles an isolated recovery database with $name", async ({ url, size }) => {
    vi.stubEnv("DATABASE_URL", url);
    stat.mockResolvedValue({ size });
    const { abortSharedGame } = await import("../games/account-deletion.js");

    await import("./reconcile-cli.js");

    expect(stat).toHaveBeenCalledExactlyOnceWith(manifestFile);
    expect(createDatabase).toHaveBeenCalledExactlyOnceWith(url);
    expect(readFile).toHaveBeenCalledExactlyOnceWith(manifestFile, "utf8");
    expect(reconcileRestoredDatabase).toHaveBeenCalledExactlyOnceWith(
      { close },
      manifest,
      abortSharedGame,
    );
    expect(close).toHaveBeenCalledExactlyOnceWith();
    expect(stdoutWrite).toHaveBeenCalledExactlyOnceWith(
      '{"event":"restore_reconciliation","status":"success"}\n',
    );
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("redacts database construction errors", async () => {
    createDatabase.mockImplementation(() => {
      throw underlyingError;
    });

    await import("./reconcile-cli.js");

    expect(reconcileRestoredDatabase).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expectFailureOutput();
  });

  it.each(["read", "parse", "reconcile"])(
    "closes the database and redacts %s failures",
    async (stage) => {
      if (stage === "read") readFile.mockRejectedValue(underlyingError);
      if (stage === "parse") readFile.mockResolvedValue(`invalid-json-canary: ${verifiedUrl}`);
      if (stage === "reconcile") reconcileRestoredDatabase.mockRejectedValue(underlyingError);

      await import("./reconcile-cli.js");

      expect(createDatabase).toHaveBeenCalledExactlyOnceWith(verifiedUrl);
      expect(close).toHaveBeenCalledExactlyOnceWith();
      if (stage !== "reconcile") expect(reconcileRestoredDatabase).not.toHaveBeenCalled();
      expectFailureOutput();
    },
  );
});
