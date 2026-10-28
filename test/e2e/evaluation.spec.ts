import AxeBuilder from "@axe-core/playwright";
import { analysisReadResponseSchema } from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, playMove, readSnapshot, submitGame, test } from "./fixtures";
import { confirm, createRoom, joinRoom, playRoomLine } from "./room-helpers";

async function configure(page: Page, color: "White" | "Black", key = "match-fixture") {
  const seat = page.getByRole("group", { name: color, exact: true });
  await expect(seat.getByLabel("Provider", { exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await seat.getByLabel("Provider", { exact: true }).selectOption("openai");
  await seat.getByLabel("API key", { exact: true }).fill(key);
  await seat.getByRole("button", { name: "Load models", exact: true }).click();
  const model = seat.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveAttribute("aria-disabled", "false");
  await model.fill("model-a");
  await model.press("ArrowDown");
  await model.press("Enter");
}

async function samples(page: Page, gameId: string) {
  const response = await page.request.get(`${API_ORIGIN}/games/${gameId}/analysis`);
  expect(response.status()).toBe(200);
  return analysisReadResponseSchema.parse(await response.json()).samples;
}

async function graph(page: Page) {
  await page.getByRole("tab", { name: "Analysis", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Evaluation graph", exact: true })).toBeVisible();
}

test("account AI observation persists every prefix and replays saved analysis without credentials", async ({
  page,
}, testInfo) => {
  await createAccount(page.request);
  await page.goto("/");
  await configure(page, "White", "telemetry-fixture");
  await configure(page, "Black");
  const { details } = await submitGame(page);
  const id = details.snapshot.gameId;
  await page.getByLabel("Delay between moves").selectOption("500");
  await expect(
    page.getByRole("heading", { name: "Black wins by checkmate", exact: true }),
  ).toBeVisible();
  await graph(page);
  await expect.poll(async () => (await samples(page, id)).length, { timeout: 30_000 }).toBe(5);
  await expect(page.getByTestId("evaluation-score")).toHaveText("Black delivered checkmate");
  await page.getByLabel("Replay position", { exact: true }).focus();
  await page.keyboard.press("Home");
  await expect(page.getByRole("grid")).toHaveAttribute("data-fen", details.snapshot.fen);
  await expect(page.getByTestId("evaluation-marker")).toHaveAttribute("data-ply", "0");
  await expect(
    page.getByRole("region", { name: "Commentary & move details", includeHidden: true }),
  ).toContainText("Initial position · no move selected.");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("evaluation-marker")).toHaveAttribute("data-ply", "1");
  await expect(
    page.getByRole("region", { name: "Commentary & move details", includeHidden: true }),
  ).toContainText("Viewer note");
  await page.getByText("Evaluation values", { exact: true }).first().click();
  await page
    .getByRole("table", { name: "Evaluation values" })
    .getByRole("button", { name: /Ply 4/ })
    .click();
  await expect(page.getByTestId("evaluation-selected")).toContainText("Black delivered checkmate");
  await expect(
    page.getByRole("link", { name: "Stockfish 19 · License and exact source" }),
  ).toHaveAttribute("href", /engines\/sf19-lite-single-v2\/index.html$/);
  expect((await new AxeBuilder({ page }).include("#arena-match").analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("evaluation-replay.png"), fullPage: true });
  const forbidden: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().startsWith(API_ORIGIN) &&
      /\/(ai-turn|controller|providers|credentials)(\/|$)/.test(new URL(request.url()).pathname)
    ) {
      forbidden.push(new URL(request.url()).pathname);
    }
  });
  await page.reload();
  await expect(
    page.getByText("Current profile: 5 of 5 positions. Missing positions remain gaps.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId("evaluation-score")).toHaveText("Black delivered checkmate");
  expect(forbidden).toEqual([]);
  await page
    .getByRole("heading", { name: "Evaluation graph", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("evaluation-graph.png"), fullPage: true });
});

for (const human of ["white", "black"] as const) {
  test(`${human} guest receives live evaluations and synchronized human/AI replay`, async ({
    page,
  }, testInfo) => {
    let storageCalls = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/analysis")) storageCalls++;
    });
    await page.goto("/");
    await expect(page.getByLabel("Game mode")).toHaveAttribute("aria-disabled", "false");
    await page.getByLabel("Game mode").selectOption("ai_vs_human");
    await page.getByLabel("Your color").selectOption(human);
    await configure(page, human === "white" ? "Black" : "White");
    const { details } = await submitGame(page);
    await expect(page.getByTestId("evaluation-score")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText("Page memory only", { exact: true }).first()).toBeVisible();
    const moves = human === "white" ? ["f2f3", "g2g4"] : ["e7e5", "d8h4"];
    for (const move of moves) {
      await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
      await playMove(
        page,
        await readSnapshot(page, details.snapshot.gameId),
        move,
        Boolean(testInfo.project.use.hasTouch),
      );
    }
    await expect(
      page.getByRole("heading", { name: "Black wins by checkmate", exact: true }),
    ).toBeVisible();
    await graph(page);
    await expect(
      page.getByText("Current profile: 5 of 5 positions. Missing positions remain gaps.", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "First", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByTestId("evaluation-marker")).toHaveAttribute("data-ply", "1");
    await expect(
      page.getByRole("region", { name: "Commentary & move details", includeHidden: true }),
    ).toContainText(
      human === "white" ? "Human move · no model invocation." : "No commentary provided",
    );
    expect(storageCalls).toBe(0);
  });
}

test("independent room accounts keep private samples through socket play, refresh and deletion", async ({
  page,
  newContext,
}, testInfo) => {
  const { invitation, gameId } = await createRoom(page, "White");
  await expect.poll(async () => (await samples(page, gameId)).length, { timeout: 25_000 }).toBe(1);
  const peer = await (
    await newContext({
      viewport: page.viewportSize(),
      isMobile: Boolean(testInfo.project.use.isMobile),
      hasTouch: Boolean(testInfo.project.use.hasTouch),
    })
  ).newPage();
  await createAccount(peer.request);
  // Delay this participant's engine: receiving the peer's evaluation would violate sample ownership.
  await peer.route("**/stockfish-19-lite-single.js", (route) => route.abort());
  await joinRoom(peer, invitation, gameId, "account");
  expect(await samples(peer, gameId)).toEqual([]);
  await expect(peer.getByRole("button", { name: "Retry analysis", exact: true })).toBeVisible();
  await peer.unroute("**/stockfish-19-lite-single.js");
  await peer.getByRole("button", { name: "Retry analysis", exact: true }).click();
  await expect.poll(async () => (await samples(peer, gameId)).length, { timeout: 25_000 }).toBe(1);
  await playRoomLine(
    page,
    peer,
    gameId,
    ["f2f3", "e7e5", "g2g4", "d8h4"],
    Boolean(testInfo.project.use.hasTouch),
  );
  for (const player of [page, peer]) {
    await graph(player);
    await expect
      .poll(async () => (await samples(player, gameId)).length, { timeout: 30_000 })
      .toBe(5);
    await expect(player.getByTestId("evaluation-score")).toHaveText("Black delivered checkmate");
  }
  await peer.reload();
  await expect(
    peer.getByText("Current profile: 5 of 5 positions. Missing positions remain gaps.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto("/history");
  const deleted = await page.request.post(`${API_ORIGIN}/games/${gameId}/delete`, {
    headers: { origin: WEB_ORIGIN },
    data: { gameId, confirm: true },
  });
  expect(deleted.status()).toBe(200);
  expect((await page.request.get(`${API_ORIGIN}/games/${gameId}/analysis`)).status()).toBe(404);
  expect(await samples(peer, gameId)).toHaveLength(5);
});

test("engine failure does not prevent an initial-position abort and replay Retry changes no game state", async ({
  page,
}) => {
  await page.route("**/stockfish-19-lite-single.js", (route) => route.abort());
  const { gameId } = await createRoom(page, "Black");
  await expect(page.getByRole("button", { name: "Retry analysis", exact: true })).toBeVisible();
  await confirm(page, "Close room", "Confirm close");
  const before = await readSnapshot(page, gameId);
  expect(before).toMatchObject({ state: "aborted", moves: [] });
  await graph(page);
  await expect(page.getByTestId("evaluation-score")).toHaveCount(0);
  await expect(page.getByTestId("evaluation-selected")).toContainText("Initial position");
  await page.unroute("**/stockfish-19-lite-single.js");
  await page.getByRole("button", { name: "Retry analysis", exact: true }).click();
  await expect.poll(async () => (await samples(page, gameId)).length, { timeout: 25_000 }).toBe(1);
  await expect(page.getByTestId("evaluation-score")).toBeVisible();
  expect(await readSnapshot(page, gameId)).toEqual(before);
});

test("uncertain analysis uploads remain unsaved until explicit retry without lifecycle effects", async ({
  page,
}) => {
  let writes = 0;
  await page.route(/\/games\/[^/]+\/analysis$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    writes++;
    await route.fulfill({ status: 200, json: {} });
  });
  const { gameId } = await createRoom(page, "White");
  await expect(page.getByTestId("evaluation-score")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId("evaluation-indicator")).toContainText("Not saved");
  await graph(page);
  await expect(
    page.getByRole("button", { name: "Retry saving analysis", exact: true }),
  ).toBeVisible();
  const before = await readSnapshot(page, gameId);
  expect(writes).toBe(1);
  expect(await samples(page, gameId)).toEqual([]);
  await page.unroute(/\/games\/[^/]+\/analysis$/);
  await page.getByRole("button", { name: "Retry saving analysis", exact: true }).click();
  await expect(page.getByTestId("evaluation-indicator")).toContainText("Saved privately");
  expect(await samples(page, gameId)).toHaveLength(1);
  expect(await readSnapshot(page, gameId)).toEqual(before);
});
