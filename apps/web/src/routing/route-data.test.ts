import type { LoaderFunctionArgs, ShouldRevalidateFunctionArgs } from "react-router";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AccountFailure } from "../api/auth-client";

import { protectedLoader, selfPostRevalidation, strictFormIntent } from "./route-data";

describe("strict route forms", () => {
  const schema = z.strictObject({ intent: z.literal("save"), label: z.string().trim() });
  it("rejects duplicates even when both values are valid and identical", () => {
    const form = new FormData();
    form.append("intent", "save");
    form.append("label", "Arena");
    form.append("label", "Arena");
    expect(strictFormIntent(form, schema)).toBeNull();
  });
  it("preserves schema transforms and rejects unexpected fields and file values", () => {
    const form = new FormData();
    form.set("intent", "save");
    form.set("label", " Arena ");
    expect(strictFormIntent(form, schema)).toEqual({ intent: "save", label: "Arena" });
    form.set("extra", "untrusted");
    expect(strictFormIntent(form, schema)).toBeNull();
    form.delete("extra");
    form.set("label", new Blob(["private"]));
    expect(strictFormIntent(form, schema)).toBeNull();
  });
});

describe("protected loader failures", () => {
  const args = (signal: AbortSignal) =>
    ({ request: new Request("https://arena.invalid/history", { signal }) }) as LoaderFunctionArgs;
  it("returns no result for request cancellation, including non-cooperative reads", async () => {
    const abort = new AbortController();
    const loader = protectedLoader(async () => {
      abort.abort();
      throw new Error("private diagnostic");
    });
    await expect(loader(args(abort.signal))).resolves.toBeNull();
  });
  it("returns no result for identity cancellation and bounds other failures", async () => {
    const signal = new AbortController().signal;
    await expect(
      protectedLoader(async () => {
        throw new AccountFailure("cancelled");
      })(args(signal)),
    ).resolves.toBeNull();
    await expect(
      protectedLoader(async () => {
        throw new Error("private diagnostic");
      })(args(signal)),
    ).rejects.toEqual(new AccountFailure("AUTH_UNAVAILABLE"));
  });
});

describe("self-POST revalidation", () => {
  it.each([
    ["POST", "/history?cursor=old", true, false],
    ["POST", "https://arena.invalid/history", true, false],
    ["POST", "/account/credentials", true, true],
    ["GET", "/history", true, true],
    [undefined, undefined, false, false],
    [undefined, undefined, true, true],
  ])(
    "preserves the default outside its own POST (%s, %s)",
    (formMethod, formAction, defaultShouldRevalidate, expected) => {
      expect(
        selfPostRevalidation("/history")({
          currentUrl: new URL("https://arena.invalid/history"),
          formMethod,
          formAction,
          defaultShouldRevalidate,
        } as ShouldRevalidateFunctionArgs),
      ).toBe(expected);
    },
  );
});
