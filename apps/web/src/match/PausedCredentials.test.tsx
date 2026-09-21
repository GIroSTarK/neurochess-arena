import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { telemetryDetails } from "../test/ai-invocations";
import { renderLocalized } from "../test/render";

import { PausedCredentials } from "./PausedCredentials";

const ready = { white: true, black: true };
const missing = { white: false, black: false };
const props = {
  seats: telemetryDetails.configuration.seats,
  keys: ready,
  rejectedColor: null,
  disabled: false,
  onKeyChange: vi.fn(),
};

describe("paused credential entry", () => {
  it("keeps ordinary pauses free of key fields and session-loss guidance", () => {
    renderLocalized(<PausedCredentials {...props} />);
    expect(screen.queryByRole("region", { name: "Keys for this tab" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/API key/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cleared when you refresh/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change API keys" })).toBeVisible();
  });

  it("shows only missing AI keys, excluding human seats", () => {
    const view = renderLocalized(
      <PausedCredentials {...props} keys={{ ...ready, black: false }} />,
    );
    expect(screen.getByLabelText("Black · Anthropic · API key")).toHaveValue("");
    expect(screen.queryByLabelText("White · OpenAI · API key")).not.toBeInTheDocument();
    view.rerender(
      <PausedCredentials
        {...props}
        keys={missing}
        seats={{ white: { type: "human" }, black: props.seats.black }}
      />,
    );
    expect(screen.getAllByLabelText(/API key/)).toHaveLength(1);
  });

  it("opens a rejected seat when the provider failure arrives without moving focus", () => {
    const view = renderLocalized(<PausedCredentials {...props} />);
    const change = screen.getByRole("button", { name: "Change API keys" });
    change.focus();
    view.rerender(<PausedCredentials {...props} rejectedColor="white" />);
    expect(screen.getByLabelText("White · OpenAI · API key")).toHaveValue("");
    expect(screen.queryByLabelText("Black · Anthropic · API key")).not.toBeInTheDocument();
    expect(
      screen.getByText("The provider rejected this key. Enter a replacement, then retry."),
    ).toBeVisible();
    expect(change).toHaveFocus();
  });

  it("opens optional replacement by keyboard without exposing or clearing existing keys", async () => {
    const onKeyChange = vi.fn();
    renderLocalized(<PausedCredentials {...props} onKeyChange={onKeyChange} />);
    const user = userEvent.setup();
    screen.getByRole("button", { name: "Change API keys" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Hide API keys" })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("White · OpenAI · API key")).toHaveFocus();
    for (const input of screen.getAllByLabelText(/API key/)) {
      expect(input).toHaveAttribute("type", "password");
      expect(input).toHaveValue("");
    }
    expect(onKeyChange).not.toHaveBeenCalled();
  });

  it("toggles the same control and preserves entered values and credentials while collapsed", async () => {
    const onKeyChange = vi.fn();
    renderLocalized(<PausedCredentials {...props} onKeyChange={onKeyChange} />);
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: "Change API keys" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveTextContent("Hide API keys");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", { name: "Keys for this tab" });
    expect(toggle).toHaveAttribute("aria-controls", panel.id);
    const input = screen.getByLabelText("White · OpenAI · API key");
    await user.type(input, "replacement-fixture");
    onKeyChange.mockClear();
    await user.click(toggle);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveTextContent("Change API keys");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).not.toBeVisible();
    await user.keyboard("{Enter}");
    expect(panel).toBeVisible();
    expect(input).toHaveValue("replacement-fixture");
    expect(input).toHaveAttribute("type", "password");
    expect(onKeyChange).not.toHaveBeenCalled();
  });

  it("allows recovery fields to collapse while keeping missing-key guidance visible", async () => {
    const onKeyChange = vi.fn();
    renderLocalized(<PausedCredentials {...props} keys={missing} onKeyChange={onKeyChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Hide API keys" }));
    expect(screen.queryByRole("region", { name: "Keys for this tab" })).not.toBeInTheDocument();
    expect(screen.getByText("Re-enter the missing API keys before continuing.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Change API keys" }));
    expect(screen.getByRole("region", { name: "Keys for this tab" })).toBeVisible();
    expect(
      screen.queryByText("Re-enter the missing API keys before continuing."),
    ).not.toBeInTheDocument();
    expect(onKeyChange).not.toHaveBeenCalled();
  });

  it("does not present an unchanged rejected key as ready after collapsing and reopening", async () => {
    renderLocalized(<PausedCredentials {...props} rejectedColor="white" />);
    const user = userEvent.setup();
    const message = "The provider rejected this key. Enter a replacement, then retry.";
    await user.click(screen.getByRole("button", { name: "Hide API keys" }));
    expect(screen.getByText(message, { selector: "p" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Change API keys" }));
    expect(screen.getByText(message, { selector: "span" })).toBeVisible();
  });

  it("retains the field and focus while entering a key that becomes ready after the first character", async () => {
    const onKeyChange = vi.fn();
    renderLocalized(<RecoveryHarness onKeyChange={onKeyChange} />);
    const input = screen.getByLabelText("White · OpenAI · API key");
    await userEvent.setup().type(input, "replacement-fixture");
    expect(input).toHaveValue("replacement-fixture");
    expect(input).toHaveFocus();
    expect(onKeyChange).toHaveBeenLastCalledWith("white", "replacement-fixture");
    expect(screen.getByLabelText("Black · Anthropic · API key")).toHaveValue("");
  });

  it("resets editing after a new paused revision and clears inputs after key loss", async () => {
    const view = renderLocalized(<PausedCredentials key="pause-1" {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Change API keys" }));
    await user.type(screen.getByLabelText("White · OpenAI · API key"), "replacement-fixture");
    view.rerender(<PausedCredentials key="pause-2" {...props} />);
    expect(screen.queryByLabelText(/API key/)).not.toBeInTheDocument();
    view.rerender(<PausedCredentials key="new-page" {...props} keys={missing} />);
    expect(screen.getByLabelText("White · OpenAI · API key")).toHaveValue("");
  });

  it("prevents optional editing and input changes while a command is pending", async () => {
    const onKeyChange = vi.fn();
    const view = renderLocalized(
      <PausedCredentials {...props} disabled onKeyChange={onKeyChange} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Change API keys" }));
    expect(screen.queryByLabelText(/API key/)).not.toBeInTheDocument();
    view.rerender(
      <PausedCredentials {...props} disabled keys={missing} onKeyChange={onKeyChange} />,
    );
    await user.type(screen.getByLabelText("White · OpenAI · API key"), "replacement-fixture");
    expect(onKeyChange).not.toHaveBeenCalled();
  });
});

function RecoveryHarness({ onKeyChange }: { readonly onKeyChange: typeof props.onKeyChange }) {
  const [keys, setKeys] = useState(missing);
  return (
    <PausedCredentials
      {...props}
      keys={keys}
      onKeyChange={(color, value) => {
        setKeys((current) => ({ ...current, [color]: value.length > 0 }));
        onKeyChange(color, value);
      }}
    />
  );
}
