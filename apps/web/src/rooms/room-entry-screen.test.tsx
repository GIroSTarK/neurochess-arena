import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderLocalized } from "../test/render";
import { INVITATION } from "../test/rooms";

import { RoomEntryMemory } from "./entry-memory";
import { RoomEntryScreen } from "./room-entry-screen";

describe("room entry screens", () => {
  it("lets an account choose Black and explains its reserved public slot", async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    renderLocalized(
      <RoomEntryScreen
        mode="setup"
        access="account"
        existingGameId={null}
        memory={new RoomEntryMemory(null)}
        onSubmit={submit}
      />,
    );
    await user.click(screen.getByRole("radio", { name: "Black" }));
    await user.click(screen.getByRole("button", { name: "Create room" }));
    expect(submit).toHaveBeenCalledWith("create", { ownerColor: "black" });
    expect(screen.getByText(/waiting room occupies your public game slot/i)).toBeVisible();
  });

  it("guides guests to sign in for creation while retaining a separate invitation path", () => {
    renderLocalized(
      <RoomEntryScreen
        mode="setup"
        access="guest"
        existingGameId={null}
        memory={new RoomEntryMemory(null)}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Create room" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/auth/sign-in?returnTo=%2Frooms",
    );
    expect(screen.getByRole("link", { name: "Join with an invitation" })).toHaveAttribute(
      "href",
      "/rooms/join",
    );
  });

  it("keeps code input in memory and submits only an explicit join intent", async () => {
    const user = userEvent.setup();
    const memory = new RoomEntryMemory(null);
    const submit = vi.fn();
    renderLocalized(
      <RoomEntryScreen
        mode="join"
        access="guest"
        existingGameId={null}
        memory={memory}
        onSubmit={submit}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "Invitation link or code" }), INVITATION);
    await user.click(screen.getByRole("button", { name: "Join as guest" }));
    expect(submit).toHaveBeenCalledWith("join", {});
    expect(memory.getSnapshot().input).toBe(INVITATION);
    expect(screen.getByText(/reopen the invitation or paste its code again/i)).toBeVisible();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });
});
