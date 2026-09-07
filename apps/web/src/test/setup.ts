import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no top layer; real modal inertness is checked in Playwright.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};

// jsdom has no layout; scrolling the model picker is exercised in the browser suite.
Element.prototype.scrollIntoView = () => undefined;

afterEach(() => cleanup());
