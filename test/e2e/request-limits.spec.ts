import { type MoveCommand, moveCommandSchema } from "@neurochess/contracts";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, readSnapshot, square, test } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";

test("a throttled room move waits for explicit retry with the same command", async ({
  page,
  newContext,
  expectedRateLimits,
}) => {
  const { gameId, invitation } = await createRoom(page, "White");
  const opponent = await (await newContext()).newPage();
  await joinRoom(opponent, invitation, gameId);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  const before = await readSnapshot(page, gameId);
  const url = `${API_ORIGIN}/games/${gameId}/moves`;
  const commands: MoveCommand[] = [];
  let retryAt = 0;
  expectedRateLimits.set(page, new Set([url]));
  await page.route(url, async (route) => {
    commands.push(moveCommandSchema.parse(route.request().postDataJSON()));
    if (commands.length !== 1) return route.continue();
    retryAt = Date.now() + 2100;
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      headers: {
        "access-control-allow-origin": WEB_ORIGIN,
        "access-control-allow-credentials": "true",
        "access-control-expose-headers": "Retry-After",
        "retry-after": "2",
      },
      body: JSON.stringify({
        code: "RATE_LIMITED",
        message: "private-response-canary",
        requestId: "fixture",
      }),
    });
  });
  await square(page, "e2").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Too many requests. Wait before retrying this action."),
  ).toBeVisible();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  await expect(page.getByText("private-response-canary")).toHaveCount(0);
  expect(await readSnapshot(page, gameId)).toEqual(before);
  await expect.poll(() => Date.now()).toBeGreaterThan(retryAt);
  expect(commands).toHaveLength(1);
  await page.getByRole("button", { name: "Retry same move", exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(opponent.getByRole("status")).toContainText("e4");
  expect((await readSnapshot(page, gameId)).moves.map((move) => move.uci)).toEqual(["e2e4"]);
});
