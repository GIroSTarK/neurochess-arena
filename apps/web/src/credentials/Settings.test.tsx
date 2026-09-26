import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderLocalized } from "../test/render";

import type { CredentialApi } from "./client";
import { CredentialContext } from "./context";
import { CredentialController } from "./controller";
import { CredentialSettings } from "./Settings";

const record = {
  credentialId: "11111111-1111-4111-8111-111111111111",
  provider: "openai" as const,
  label: "Personal",
  maskedSuffix: "test",
  createdAt: "2026-09-26T00:00:00.000Z",
};
function fixture() {
  const api = {
    list: vi.fn<CredentialApi["list"]>().mockResolvedValue({ credentials: [], nextCursor: null }),
    save: vi.fn<CredentialApi["save"]>().mockResolvedValue(record),
    revoke: vi.fn<CredentialApi["revoke"]>().mockResolvedValue({ success: true }),
    clear: vi.fn<CredentialApi["clear"]>().mockResolvedValue({ success: true }),
  };
  const lifetime = new AbortController();
  const controller = new CredentialController(api, lifetime.signal, vi.fn());
  function Harness() {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    return (
      <CredentialContext value={{ controller, state }}>
        <CredentialSettings />
      </CredentialContext>
    );
  }
  renderLocalized(<Harness />);
  return { api, lifetime, controller, user: userEvent.setup() };
}
describe("saved credential settings", () => {
  it("requires unchecked opt-in, clears submitted secrets, and confirms each removal with Cancel focused", async () => {
    const { api, user } = fixture();
    const checkbox = screen.getByRole("checkbox", { name: "Save this key to my account" });
    expect(checkbox).not.toBeChecked();
    const key = screen.getByLabelText("API key", { exact: true });
    await user.type(key, "settings-secret-sentinel");
    await user.type(screen.getByLabelText("Label", { exact: true }), "Personal");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(api.save).not.toHaveBeenCalled();
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(key).toHaveValue("");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText(/••••test/)).toBeVisible();
    expect(document.body.textContent).not.toContain("settings-secret-sentinel");
    await user.click(screen.getByRole("button", { name: "Revoke Personal" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(api.revoke).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Revoke key" }));
    await waitFor(() => expect(api.revoke).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/••••test/)).not.toBeInTheDocument();
  });

  it("clears raw form values on pagehide and requires a distinct clear-all confirmation", async () => {
    const { controller, api, user } = fixture();
    await user.type(screen.getByLabelText("API key", { exact: true }), "transient-key");
    fireEvent(window, new Event("pagehide"));
    expect(screen.getByLabelText("API key", { exact: true })).toHaveValue("");
    await controller.save({});
    await user.click(screen.getByRole("button", { name: "Clear all saved keys" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Clear all saved keys" }));
    await waitFor(() => expect(api.clear).toHaveBeenCalledTimes(1));
  });
});
