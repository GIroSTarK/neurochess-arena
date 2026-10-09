import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderLocalized } from "../test/render";
import { INVITATION, waitingRoom } from "../test/rooms";

import { RoomEntryMemory } from "./entry-memory";
import { RoomEntryScreen } from "./room-entry-screen";
import { RoomWaitingScreen } from "./room-waiting-screen";

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

  it("shows a selectable invitation when clipboard access fails and confirms owner actions Cancel first", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("unavailable"));
    const memory = new RoomEntryMemory(null);
    memory.update({ room: waitingRoom("black"), issuedInvitation: INVITATION });
    const submit = vi.fn();
    renderLocalized(<RoomWaitingScreen memory={memory} onSubmit={submit} />);
    await user.click(screen.getByRole("button", { name: "Copy invitation" }));
    expect(await screen.findByText(/select and copy the invitation/i)).toBeVisible();
    const link = screen.getByRole("textbox", { name: "Invitation link" });
    expect(link).toHaveValue(`${window.location.origin}/rooms/join#invite=${INVITATION}`);
    await user.click(link);
    expect((link as HTMLTextAreaElement).selectionEnd).toBe(
      (link as HTMLTextAreaElement).value.length,
    );
    expect(screen.getByText("Waiting for White")).toBeVisible();
    expect(screen.queryByRole("button", { name: /resign|resume|pause/i })).not.toBeInTheDocument();
    for (const label of ["Revoke invitation", "Replace invitation", "Close room"]) {
      await user.click(screen.getByRole("button", { name: label }));
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      await user.click(screen.getByRole("button", { name: "Cancel" }));
    }
    expect(submit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close room" }));
    await user.click(screen.getByRole("button", { name: "Confirm close" }));
    expect(submit).toHaveBeenCalledWith(
      "close",
      expect.objectContaining({ confirm: "true", expectedVersion: "0" }),
    );
  });

  it("offers replacement after reload and retains the room when admission is revoked", () => {
    const memory = new RoomEntryMemory(null);
    memory.update({ room: { ...waitingRoom(), invitationAvailable: false } });
    renderLocalized(<RoomWaitingScreen memory={memory} onSubmit={vi.fn()} />);
    expect(screen.getByText(/replace the invitation to share a new link/i)).toBeVisible();
    expect(screen.getByText(/your public game slot stays reserved/i)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Invitation link" })).not.toBeInTheDocument();
  });
});
