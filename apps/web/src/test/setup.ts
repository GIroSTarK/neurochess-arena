import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// jsdom has no top layer; real modal inertness is checked in Playwright.
if (typeof HTMLDialogElement !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  await import("../i18n");
  afterEach(() => cleanup());
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
}
