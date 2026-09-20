import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Scrolling and focused-element visibility are verified in the browser suite.
Element.prototype.scrollIntoView = () => undefined;
// jsdom has no top layer; real modal inertness is checked in Playwright.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};

afterEach(() => cleanup());
