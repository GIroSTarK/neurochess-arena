import { act, fireEvent, screen } from "@testing-library/react";
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
  it("does not describe an exclusively saved selection as a session-only key", () => {
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
      screen.queryByRole("region", { name: "Re-enter your API keys" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/API key/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("replaces details with only the missing AI fields without moving focus on load", () => {
    renderLocalized(
      <PausedCredentials {...props} keys={{ ...ready, black: false }} canContinue={false} />,
    );
    expect(screen.getByRole("region", { name: "Re-enter your API keys" })).toBeVisible();
    expect(screen.getByText("Game details")).not.toBeVisible();
    expect(screen.getByLabelText("Black · Anthropic · API key")).toHaveValue("");
    expect(screen.queryByLabelText("White · OpenAI · API key")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume game" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(document.body).toHaveFocus();
  });

  it("excludes human seats", () => {
    renderLocalized(
      <PausedCredentials
        {...props}
        keys={missing}
        seats={{ white: { type: "human" }, black: props.seats.black }}
      />,
    );
    expect(screen.getByLabelText("Black · Anthropic · API key")).toBeVisible();
    expect(screen.queryByLabelText("White · OpenAI · API key")).not.toBeInTheDocument();
  });

  it("opens the rejected seat when authentication fails on the same paused revision", async () => {
    const onResume = vi.fn();
    const view = renderLocalized(<PausedCredentials {...props} onResume={onResume} />);
    view.rerender(<PausedCredentials {...props} onResume={onResume} rejectedColor="white" />);
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

  it("keeps fields and focus while typing and waits for explicit Resume", async () => {
    const onResume = vi.fn();
    renderLocalized(<RecoveryHarness onResume={onResume} />);
    const user = userEvent.setup();
    const white = screen.getByLabelText("White · OpenAI · API key");
    await user.type(white, "replacement-fixture");
    expect(white).toHaveFocus();
    expect(white).toHaveValue("replacement-fixture");
    expect(screen.getByRole("button", { name: "Resume game" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.type(screen.getByLabelText("Black · Anthropic · API key"), "second-fixture");
    expect(screen.getByText("Game details")).not.toBeVisible();
    expect(onResume).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Resume game" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("returns to details with recovery guidance, then restores masked fields and keyboard focus", async () => {
    const onResume = vi.fn();
    renderLocalized(<RecoveryHarness onResume={onResume} />);
    const user = userEvent.setup();
    const input = screen.getByLabelText("White · OpenAI · API key");
    await user.type(input, "replacement-fixture");
    await user.click(screen.getByRole("button", { name: "Show White API key" }));
    expect(input).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Return to game" }));
    expect(screen.getByText("Game details")).toBeVisible();
    expect(screen.getByText("Re-enter the missing API keys before continuing.")).toBeVisible();
    const reopen = screen.getByRole("button", { name: "Re-enter your API keys" });
    expect(reopen).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Re-enter your API keys" })).toHaveFocus();
    expect(input).toHaveValue("replacement-fixture");
    expect(input).toHaveAttribute("type", "password");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("preserves the selected detail tab while recovery replaces it", async () => {
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
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Return to game" }));
    expect(screen.getByRole("tab", { name: "Analysis" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Operational totals")).toBeVisible();
  });

  it("masks keys even when recovery reopens before hidden background rendering", async () => {
    renderLocalized(<RecoveryHarness onResume={vi.fn()} />);
    const user = userEvent.setup();
    const input = screen.getByLabelText("White · OpenAI · API key");
    await user.type(input, "replacement-fixture");
    await user.click(screen.getByRole("button", { name: "Show White API key" }));
    expect(input).toHaveAttribute("type", "text");

    act(() => {
      flushSync(() => fireEvent.click(screen.getByRole("button", { name: "Return to game" })));
      flushSync(() =>
        fireEvent.click(screen.getByRole("button", { name: "Re-enter your API keys" })),
      );
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
    await userEvent
      .setup()
      .type(screen.getByLabelText("White · OpenAI · API key"), "replacement-fixture");
    view.rerender(<PausedCredentials {...props} epoch="new-page" keys={missing} />);
    expect(screen.getByLabelText("White · OpenAI · API key")).toHaveValue("");
    view.rerender(<PausedCredentials {...props} epoch="resumed" paused={false} />);
    expect(
      screen.queryByRole("region", { name: "Re-enter your API keys" }),
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
