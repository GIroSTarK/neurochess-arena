import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";

import { telemetryDetails } from "../test/ai-invocations";
import { renderLocalized } from "../test/render";
import { DetailTabs } from "../ui/detail-tabs";

import { PausedCredentials } from "./paused-credentials";

const ready = { white: true, black: true };
const missing = { white: false, black: false };
const props = {
  epoch: "pause-1",
  paused: true,
  seats: telemetryDetails.configuration.seats,
  keys: ready,
  rejectedColor: null,
  disabled: false,
  canContinue: true,
  onKeyChange: vi.fn(),
  onResume: vi.fn(),
  children: <p>Game details</p>,
};

describe("paused credential recovery", () => {
  it("restores the trigger when pointer activation does not focus buttons", async () => {
    renderLocalized(
      <PausedCredentials {...props} keys={missing}>
        <button type="button">Inspector focus</button>
      </PausedCredentials>,
    );
    screen.getByRole("button", { name: "Inspector focus" }).focus();
    const trigger = screen.getByRole("button", { name: "Restore keys" });
    fireEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("does not describe an exclusively saved selection as a session-only key", async () => {
    renderLocalized(
      <PausedCredentials
        {...props}
        rejectedColor="white"
        selections={{
          white: "61111111-1111-4111-8111-111111111111",
          black: "72222222-2222-4222-8222-222222222222",
        }}
        savedCredentials={{ phase: "ready", credentials: [], onRefresh: () => undefined }}
      />,
    );
    await openRecovery();
    expect(
      screen.queryByText("Cleared when you refresh or close this tab."),
    ).not.toBeInTheDocument();
  });
  it("offers provider-matched saved references while keeping explicit continuation and human seats excluded", async () => {
    const credentialId = "61111111-1111-4111-8111-111111111111";
    const onCredentialChange = vi.fn();
    const onResume = vi.fn();
    renderLocalized(
      <PausedCredentials
        {...props}
        keys={missing}
        seats={{ white: { type: "human" }, black: props.seats.black }}
        selections={{ white: "session", black: "session" }}
        savedCredentials={{
          phase: "ready",
          onRefresh: () => undefined,
          credentials: [
            {
              credentialId,
              provider: "anthropic",
              label: "Saved opponent",
              maskedSuffix: "1234",
              createdAt: "2026-10-01T00:00:00.000Z",
            },
            {
              credentialId: "72222222-2222-4222-8222-222222222222",
              provider: "openai",
              label: "Wrong provider",
              maskedSuffix: null,
              createdAt: "2026-10-01T00:00:00.000Z",
            },
          ],
        }}
        onCredentialChange={onCredentialChange}
        onResume={onResume}
      />,
    );
    await openRecovery();
    const source = screen.getByLabelText("Black · Anthropic · Credential source");
    expect(source).toHaveValue("session");
    expect(screen.queryByRole("option", { name: /Wrong provider/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(source, credentialId);
    expect(onCredentialChange).toHaveBeenCalledWith("black", credentialId);
    expect(onResume).not.toHaveBeenCalled();
  });
  it("keeps ordinary pauses free of key fields and replacement controls", () => {
    renderLocalized(<PausedCredentials {...props} />);
    expect(screen.getByText("Game details")).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Re-enter your API keys" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/API key/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens only the missing AI fields explicitly without moving focus on load", async () => {
    renderLocalized(
      <PausedCredentials {...props} keys={{ ...ready, black: false }} canContinue={false} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();
    expect(screen.getByText("Game details")).toBeVisible();
    await openRecovery();
    expect(screen.getByRole("dialog", { name: "Re-enter your API keys" })).toBeVisible();
    expect(screen.getByLabelText("Black · Anthropic · API key")).toHaveValue("");
    expect(screen.queryByLabelText("White · OpenAI · API key")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume game" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("excludes human seats", async () => {
    renderLocalized(
      <PausedCredentials
        {...props}
        keys={missing}
        seats={{ white: { type: "human" }, black: props.seats.black }}
      />,
    );
    await openRecovery();
    expect(screen.getByLabelText("Black · Anthropic · API key")).toBeVisible();
    expect(screen.queryByLabelText("White · OpenAI · API key")).not.toBeInTheDocument();
  });

  it("offers the rejected seat without auto-opening when authentication fails on the same paused revision", async () => {
    const onResume = vi.fn();
    const view = renderLocalized(<PausedCredentials {...props} onResume={onResume} />);
    view.rerender(<PausedCredentials {...props} onResume={onResume} rejectedColor="white" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await openRecovery();
    expect(screen.getByLabelText("White · OpenAI · API key")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.queryByLabelText("Black · Anthropic · API key")).not.toBeInTheDocument();
    const resume = screen.getByRole("button", { name: "Resume game" });
    await userEvent.setup().click(resume);
    expect(onResume).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .type(screen.getByLabelText("White · OpenAI · API key"), "replacement-fixture");
    expect(screen.getByLabelText("White · OpenAI · API key")).toHaveAttribute(
      "aria-invalid",
      "false",
    );
    await userEvent.setup().click(resume);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("does not remove a field when it becomes ready", async () => {
    const onResume = vi.fn();
    renderLocalized(<RecoveryHarness onResume={onResume} />);
    const user = userEvent.setup();
    await openRecovery();
    const white = screen.getByLabelText("White · OpenAI · API key");
    await user.type(white, "replacement-fixture");
    expect(white).toHaveFocus();
    expect(white).toHaveValue("replacement-fixture");
    expect(screen.getByRole("button", { name: "Resume game" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.type(screen.getByLabelText("Black · Anthropic · API key"), "second-fixture");
    expect(screen.getByText("Game details")).toBeVisible();
    expect(onResume).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Resume game" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it.each(["Keep paused", "Escape", "Close key recovery"])(
    "reopens the same affected fields masked after %s",
    async (dismissal) => {
      const onResume = vi.fn();
      renderLocalized(<RecoveryHarness onResume={onResume} />);
      const user = userEvent.setup();
      await openRecovery();
      const input = screen.getByLabelText("White · OpenAI · API key");
      await user.type(input, "replacement-fixture");
      await user.click(screen.getByRole("button", { name: "Show White API key" }));
      expect(input).toHaveAttribute("type", "text");
      if (dismissal === "Escape") await user.keyboard("{Escape}");
      else await user.click(screen.getByRole("button", { name: dismissal }));
      expect(screen.getByText("Game details")).toBeVisible();
      expect(screen.getByText("Re-enter the missing API keys before continuing.")).toBeVisible();
      const reopen = screen.getByRole("button", { name: "Restore keys" });
      expect(reopen).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("button", { name: "Close key recovery" })).toHaveFocus();
      expect(input).toHaveValue("replacement-fixture");
      expect(input).toHaveAttribute("type", "password");
      expect(onResume).not.toHaveBeenCalled();
    },
  );

  it("keeps the inspector mounted while recovery is open", async () => {
    const children = (
      <DetailTabs
        label="Game details"
        tabs={[
          { id: "moves", label: "Moves", content: "Move list" },
          { id: "analysis", label: "Analysis", content: "Operational totals" },
        ]}
      />
    );
    const view = renderLocalized(<PausedCredentials {...props}>{children}</PausedCredentials>);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Analysis" }));
    view.rerender(
      <PausedCredentials {...props} keys={missing}>
        {children}
      </PausedCredentials>,
    );
    const inspector = screen.getByRole("tablist");
    await openRecovery();
    expect(screen.getByRole("tablist")).toBe(inspector);
    expect(screen.getByText("Operational totals")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Keep paused" }));
    expect(screen.getByRole("tab", { name: "Analysis" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Operational totals")).toBeVisible();
  });

  it("masks keys even when recovery reopens before hidden background rendering", async () => {
    renderLocalized(<RecoveryHarness onResume={vi.fn()} />);
    const user = userEvent.setup();
    await openRecovery();
    const input = screen.getByLabelText("White · OpenAI · API key");
    await user.type(input, "replacement-fixture");
    await user.click(screen.getByRole("button", { name: "Show White API key" }));
    expect(input).toHaveAttribute("type", "text");

    act(() => {
      flushSync(() => fireEvent.click(screen.getByRole("button", { name: "Keep paused" })));
      flushSync(() => fireEvent.click(screen.getByRole("button", { name: "Restore keys" })));
    });

    expect(input).toHaveValue("replacement-fixture");
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show White API key" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("clears recovery values on a new revision or credential lifetime and closes on continuation", async () => {
    const view = renderLocalized(<PausedCredentials {...props} keys={missing} />);
    await openRecovery();
    await userEvent
      .setup()
      .type(screen.getByLabelText("White · OpenAI · API key"), "replacement-fixture");
    view.rerender(<PausedCredentials {...props} epoch="new-page" keys={missing} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await openRecovery();
    expect(screen.getByLabelText("White · OpenAI · API key")).toHaveValue("");
    view.rerender(<PausedCredentials {...props} epoch="resumed" paused={false} />);
    expect(
      screen.queryByRole("dialog", { name: "Re-enter your API keys" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Game details")).toBeVisible();
  });

  it("keeps empty keys masked and prevents editing or resuming during a pending command", async () => {
    const onKeyChange = vi.fn();
    const onResume = vi.fn();
    renderLocalized(
      <PausedCredentials
        {...props}
        disabled
        keys={missing}
        onKeyChange={onKeyChange}
        onResume={onResume}
      />,
    );
    const user = userEvent.setup();
    await openRecovery();
    const input = screen.getByLabelText("White · OpenAI · API key");
    await user.type(input, "replacement-fixture");
    await user.click(screen.getByRole("button", { name: "Show White API key" }));
    await user.click(screen.getByRole("button", { name: "Resume game" }));
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");
    expect(onKeyChange).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });
});

function RecoveryHarness({ onResume }: { readonly onResume: () => void }) {
  const [keys, setKeys] = useState(missing);
  return (
    <PausedCredentials
      {...props}
      keys={keys}
      canContinue={keys.white && keys.black}
      onResume={onResume}
      onKeyChange={(color, value) =>
        setKeys((current) => ({ ...current, [color]: value.length > 0 }))
      }
    />
  );
}

async function openRecovery() {
  await userEvent.click(screen.getByRole("button", { name: "Restore keys" }));
  return within(screen.getByRole("dialog"));
}
