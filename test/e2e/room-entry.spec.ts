import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { expectArenaLayout, expectArenaTransition } from "./arena-layout";
import { expectClipboardCopy } from "./clipboard";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";
import { confirm, createRoom, room } from "./room-helpers";
import { setPseudoLocalization } from "./text-layout";

const entryPath = "/rooms";
const joinPath = entryPath + "/join";

test("waiting room keeps board-first invitation access across desktop tablet and phone layouts", async ({
  page,
}, testInfo) => {
  await createRoom(page, "Black");
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectArenaLayout(page);
    await page.screenshot({ path: testInfo.outputPath(`waiting-${width}.png`), fullPage: true });
  }
  await expectArenaTransition(page);
  const play = page.getByRole("region", { name: /^Play area/ });
  const sharing = page.getByRole("region", { name: /^Share invitation/ });
  const originalUrl = page.url();
  const invitation = await page
    .getByRole("textbox", { name: "Invitation link", exact: true })
    .inputValue();
  let gameplayWrites = 0;
  let sockets = 0;
  page.on("websocket", () => sockets++);
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(moves|lifecycle|invitation)$/.test(new URL(request.url()).pathname)
    ) {
      gameplayWrites++;
    }
  });
  for (const enlarged of [false, true]) {
    await setPseudoLocalization(page, enlarged);
    await page.evaluate((enlarged) => {
      document.documentElement.style.fontSize = enlarged ? "200%" : "";
    }, enlarged);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 700 : 900 });
      const invite = play.getByRole("button", { name: /^Invite opponent/ });
      await invite.focus();
      await page.keyboard.press("Enter");
      await expect(sharing).toBeFocused();
      const focus = await sharing.evaluate((element) => {
        const style = getComputedStyle(element);
        return { width: Number.parseFloat(style.outlineWidth), style: style.outlineStyle };
      });
      expect(focus.style).not.toBe("none");
      expect(focus.width).toBeGreaterThanOrEqual(2);
      await expect(sharing.getByRole("heading", { name: /^Share invitation/ })).toBeInViewport();
      await expect(sharing.getByRole("textbox", { name: /^Invitation code/ })).toHaveValue(
        new URL(invitation).hash.slice("#invite=".length),
      );
      await expect(sharing.getByRole("button", { name: /^Replace invitation/ })).toBeVisible();
      await expect(sharing.getByRole("button", { name: /^Revoke invitation/ })).toBeVisible();
      await expect(play.getByRole("button", { name: /^Close room/ })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(page.url()).toBe(originalUrl);
    }
  }
  expect(gameplayWrites).toBe(0);
  expect(sockets).toBe(0);
});

test("same-document invitation fragments are consumed before routing and cannot return through history", async ({
  page,
  newContext,
}) => {
  const { invitation: link } = await createRoom(page, "White");
  const token = new URL(link).hash.slice("#invite=".length);
  const guest = await (await newContext()).newPage();
  await guest.goto(joinPath);
  await expect(guest.getByRole("textbox", { name: "Invitation link or code" })).toHaveValue("");
  await guest.evaluate((value) => {
    window.location.hash = "invite=" + value;
  }, token);
  await expect(guest).toHaveURL(WEB_ORIGIN + joinPath);
  await expect
    .poll(
      async () =>
        (await guest.getByRole("textbox", { name: "Invitation link or code" }).inputValue()) ===
        token,
    )
    .toBe(true);
  await assertNoStoredInvitation(guest, token);
  await guest.getByRole("link", { name: "Arena", exact: true }).click();
  await guest.goBack();
  await expect(guest.getByRole("textbox", { name: "Invitation link or code" })).toHaveValue("");
  await guest.goForward();
  await guest.goBack();
  await assertNoStoredInvitation(guest, token);
});
async function assertNoStoredInvitation(page: Page, token: string) {
  expect(
    await page.evaluate((token) => {
      const values = (storage: Storage) =>
        Array.from({ length: storage.length }, (_, index) =>
          storage.getItem(storage.key(index) ?? ""),
        );
      return JSON.stringify({
        local: values(localStorage),
        session: values(sessionStorage),
        history: history.state as unknown,
        url: location.href,
      }).includes(token);
    }, token),
  ).toBe(false);
}

test("Black owner creates and a separate guest explicitly joins by link with no private preview", async ({
  page,
  newContext,
}) => {
  const { invitation: link, gameId } = await createRoom(page, "Black");
  const guest = await (await newContext()).newPage();
  let bootstraps = 0;
  guest.on("request", (request) => {
    if (request.url() === API_ORIGIN + "/guest-session") bootstraps++;
  });
  await guest.goto(link);
  await expect(guest).toHaveURL(WEB_ORIGIN + joinPath);
  await expect(
    guest.getByText("This invitation is available. Join when you are ready."),
  ).toBeVisible();
  expect(bootstraps).toBe(0);
  await expect(guest.getByRole("grid")).toHaveCount(0);
  const token = new URL(link).hash.slice("#invite=".length);
  await assertNoStoredInvitation(guest, token);
  await guest.getByRole("button", { name: "Join as guest", exact: true }).click();
  await expect(guest).toHaveURL(`${WEB_ORIGIN}/games/${gameId}`);
  await expect(guest.getByTestId("room-connection")).toHaveText("Room connected");
  await expect(guest.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  expect(bootstraps).toBe(1);
  const joined = await room(guest, gameId);
  expect(joined.viewer).toEqual({ color: "white", isOwner: false });
  expect(joined.snapshot.state).toBe("active");
  await expect(page.getByRole("heading", { name: "Waiting for opponent" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resign", exact: true })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  expect((await room(page, gameId)).snapshot).toEqual(joined.snapshot);
});

test("manual code join, invitation replacement/revocation, reload recovery and confirmed owner closure", async ({
  page,
  newContext,
}) => {
  const { invitation: first, gameId } = await createRoom(page, "White");
  const guest = await (await newContext()).newPage();
  await confirm(page, "Revoke invitation", "Confirm revocation");
  await expect(page.getByText(/Your public game slot stays reserved/)).toBeVisible();
  await guest.goto(first);
  await expect(
    guest.getByText("This invitation is unavailable. Ask the owner for a new one."),
  ).toBeVisible();
  await confirm(page, "Replace invitation", "Confirm replacement");
  const replacement = await page
    .getByRole("textbox", { name: "Invitation link", exact: true })
    .inputValue();
  expect(replacement === first).toBe(false);
  await page.reload();
  await expect(page.getByText(/Replace the invitation to share a new link/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Invitation link", exact: true })).toHaveCount(0);
  await confirm(page, "Replace invitation", "Confirm replacement");
  const current = await page
    .getByRole("textbox", { name: "Invitation link", exact: true })
    .inputValue();
  await guest
    .getByRole("textbox", { name: "Invitation link or code" })
    .fill(new URL(current).hash.slice("#invite=".length));
  await guest.getByRole("button", { name: "Join as guest", exact: true }).click();
  await expect(guest).toHaveURL(`${WEB_ORIGIN}/games/${gameId}`);
  await expect(guest.getByTestId("room-connection")).toHaveText("Room connected");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  expect((await room(guest, gameId)).snapshot.state).toBe("active");
  const otherOwner = await (await newContext()).newPage();
  const other = await createRoom(otherOwner, "White");
  await otherOwner.getByRole("button", { name: "Close room", exact: true }).click();
  await otherOwner.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(otherOwner.getByRole("heading", { name: "Waiting for opponent" })).toBeVisible();
  await confirm(otherOwner, "Close room", "Confirm close");
  await expect(
    otherOwner.getByRole("heading", { name: "Game stopped", exact: true }),
  ).toBeVisible();
  await expect(otherOwner.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  expect((await room(otherOwner, other.gameId)).snapshot.state).toBe("aborted");
});

test("lost create and join acknowledgements recover the same operation and seat", async ({
  page,
  newContext,
}) => {
  await createAccount(page.request);
  let creates = 0;
  let operations = 0;
  const createBodies: string[] = [];
  page.on("request", (request) => {
    if (request.url() === API_ORIGIN + "/rooms/creation-operation") operations++;
  });
  await page.route(API_ORIGIN + "/rooms", async (route) => {
    createBodies.push(route.request().postData() ?? "");
    const response = await route.fetch();
    if (++creates === 1) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    } else await route.fulfill({ response });
  });
  await page.goto(entryPath);
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("acknowledgement was lost");
  await page.getByRole("button", { name: "Recover previous request", exact: true }).click();
  await expect(page).toHaveURL(/\/games\/[a-f0-9-]+$/);
  await expect(page.getByRole("heading", { name: "Waiting for opponent" })).toBeVisible();
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
  const gameId = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(operations).toBe(1);
  expect(createBodies).toHaveLength(2);
  expect(createBodies[0]).toBe(createBodies[1]);
  await confirm(page, "Replace invitation", "Confirm replacement");
  const link = await page
    .getByRole("textbox", { name: "Invitation link", exact: true })
    .inputValue();
  const guest = await (await newContext()).newPage();
  const joinBodies: string[] = [];
  await guest.route(API_ORIGIN + "/rooms/join", async (route) => {
    joinBodies.push(route.request().postData() ?? "");
    const response = await route.fetch();
    if (joinBodies.length === 1) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    } else await route.fulfill({ response });
  });
  await guest.goto(link);
  await guest.getByRole("button", { name: "Join as guest", exact: true }).click();
  await expect(guest.getByRole("alert")).toContainText("acknowledgement was lost");
  await guest.getByRole("button", { name: "Recover previous request", exact: true }).click();
  await expect(guest).toHaveURL(`${WEB_ORIGIN}/games/${gameId}`);
  await expect(guest.getByTestId("room-connection")).toHaveText("Room connected");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  const joined = await room(guest, gameId);
  expect(joined.viewer).toEqual({ color: "black", isOwner: false });
  expect(joined.snapshot.state).toBe("active");
  expect(joinBodies).toHaveLength(2);
  expect(joinBodies[0] === joinBodies[1]).toBe(true);
});

test("sign-in departure and Back/Forward clear invitations and token-free auth returns work", async ({
  page,
  newContext,
}) => {
  const { invitation: link } = await createRoom(page, "White");
  const guest = await (await newContext()).newPage();
  const account = await createAccount(guest.request);
  // Sign out through the real account API before entering the guest invitation flow.
  await guest.request.post(API_ORIGIN + "/api/auth/sign-out", {
    headers: { origin: WEB_ORIGIN },
    data: {},
  });
  await guest.goto(link);
  await expect(guest.getByRole("textbox", { name: "Invitation link or code" })).not.toHaveValue("");
  await guest.getByRole("main").getByRole("link", { name: "Sign in", exact: true }).click();
  const token = new URL(link).hash.slice("#invite=".length);
  await assertNoStoredInvitation(guest, token);
  await guest.goBack();
  await expect(guest.getByRole("textbox", { name: "Invitation link or code" })).toHaveValue("");
  await guest.goForward();
  await guest.getByLabel("Email", { exact: true }).fill(account.email);
  await guest.getByLabel("Password", { exact: true }).fill(account.password);
  await guest.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(guest).toHaveURL(WEB_ORIGIN + joinPath);
  await expect(guest.getByRole("textbox", { name: "Invitation link or code" })).toHaveValue("");
});

test("entry and waiting remain accessible with keyboard, clipboard fallback and expanded mobile text", async ({
  page,
  browserName,
}) => {
  await page.goto(entryPath);
  await expect(
    page.getByRole("main").getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await createRoom(page, "Black");
  const expectedLink = await page
    .getByRole("textbox", { name: "Invitation link", exact: true })
    .inputValue();
  await expectClipboardCopy(
    page,
    page.getByRole("button", { name: "Copy invitation", exact: true }),
    expectedLink,
    browserName,
  );
  await expect(page.getByText("Invitation copied.", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
  });
  await page.getByRole("button", { name: "Copy invitation", exact: true }).click();
  await expect(page.getByText(/Select and copy the invitation above/)).toBeVisible();
  const invitation = page.getByRole("textbox", { name: "Invitation link", exact: true });
  await invitation.focus();
  expect(
    await invitation.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      return field.selectionEnd === field.value.length;
    }),
  ).toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Copy invitation", exact: true })).toBeFocused();
  expect(
    await page
      .getByRole("button", { name: "Copy invitation", exact: true })
      .evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await setPseudoLocalization(page, true);
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: /^Close room/ }).click();
  await expect(page.getByRole("button", { name: /^Cancel/ })).toBeFocused();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test("onboarding returns without the invitation and an account joins after pasting it again", async ({
  page,
  newContext,
}) => {
  const { invitation: link, gameId } = await createRoom(page, "White");
  const invitee = await (await newContext()).newPage();
  const account = await createAccount(invitee.request, { completeProfile: false });
  await invitee.goto(link);
  await expect(
    invitee.getByText(/Leaving for sign-in or profile setup clears this invitation/),
  ).toBeVisible();
  await invitee.getByRole("link", { name: "Complete profile", exact: true }).click();
  await invitee.getByLabel("Username", { exact: true }).fill(account.username);
  await invitee.getByRole("button", { name: "Finish profile", exact: true }).click();
  await expect(invitee).toHaveURL(WEB_ORIGIN + joinPath);
  await expect(invitee.getByRole("textbox", { name: "Invitation link or code" })).toHaveValue("");
  await invitee.getByRole("textbox", { name: "Invitation link or code" }).fill(link);
  await invitee.getByRole("button", { name: "Join room", exact: true }).click();
  await expect(invitee).toHaveURL(`${WEB_ORIGIN}/games/${gameId}`);
  await expect(invitee.getByTestId("room-connection")).toHaveText("Room connected");
  await expect(invitee.getByRole("button", { name: "Resign", exact: true })).toBeVisible();
  expect((await room(invitee, gameId)).viewer).toEqual({ color: "black", isOwner: false });
});

test("identity changes and pagehide remove the issued invitation and open confirmations", async ({
  page,
}) => {
  const { invitation: link } = await createRoom(page, "White");
  await page.getByRole("button", { name: "Close room", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Invitation link", exact: true })).toHaveCount(0);
  await assertNoStoredInvitation(page, new URL(link).hash.slice("#invite=".length));
  await page.reload();
  await confirm(page, "Replace invitation", "Confirm replacement");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Invitation link", exact: true })).toHaveCount(0);
  await expect(page.getByRole("grid")).toHaveCount(0);
});

test("occupied slots and invalid invitations show bounded feedback", async ({
  page,
  newContext,
}) => {
  await createRoom(page, "White");
  await page.getByRole("link", { name: "Private rooms", exact: true }).click();
  await expect(page.getByText(/You already have an unfinished public game/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create room", exact: true })).toHaveCount(0);
  const guest = await (await newContext()).newPage();
  await guest.goto(joinPath);
  await guest.getByRole("textbox", { name: "Invitation link or code" }).fill("not an invitation");
  await guest.getByRole("button", { name: "Check invitation", exact: true }).click();
  await expect(guest.getByRole("alert")).toContainText("Enter a valid invitation");
  await guest.getByRole("textbox", { name: "Invitation link or code" }).fill("A".repeat(43));
  await guest.getByRole("button", { name: "Check invitation", exact: true }).click();
  await expect(
    guest.getByText("This invitation is unavailable. Ask the owner for a new one."),
  ).toBeVisible();
});
