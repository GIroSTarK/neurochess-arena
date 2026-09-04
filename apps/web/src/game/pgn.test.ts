import { afterEach, describe, expect, it, vi } from "vitest";

import { GAME_ID } from "../test/fixtures";

import { browserPgnDelivery } from "./pgn";

const PGN = '[Event "Sandbox"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *\n';
const OBJECT_URL = "blob:neurochess/export";

// jsdom defines neither object URLs nor a clipboard; each test supplies its own and leaves none.
const objectUrlDescriptors = {
  createObjectURL: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
  revokeObjectURL: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
};

function stubObjectUrls() {
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => OBJECT_URL);
  const revokeObjectURL = vi.fn<(url: string) => void>();
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
  return { createObjectURL, revokeObjectURL };
}

afterEach(() => {
  for (const [name, descriptor] of Object.entries(objectUrlDescriptors)) {
    if (descriptor) Object.defineProperty(URL, name, descriptor);
    else Reflect.deleteProperty(URL, name);
  }
});

describe("browser PGN delivery", () => {
  it("copies the exact text and reports success", async () => {
    const writeText = vi.fn<Clipboard["writeText"]>().mockResolvedValue();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(browserPgnDelivery.copy(PGN)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(PGN);
  });

  it("reports failure when the clipboard is missing or refuses, without throwing", async () => {
    vi.stubGlobal("navigator", {});
    await expect(browserPgnDelivery.copy(PGN)).resolves.toBe(false);
    const writeText = vi.fn<Clipboard["writeText"]>().mockRejectedValue(new Error("denied-canary"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(browserPgnDelivery.copy(PGN)).resolves.toBe(false);
  });

  it("downloads the exact text as a PGN file named after the game, then revokes the URL", async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrls();
    const clicks: { href: string; download: string; connected: boolean }[] = [];
    vi.spyOn(HTMLElement.prototype, "click").mockImplementation(function (this: HTMLElement) {
      if (!(this instanceof HTMLAnchorElement)) throw new Error("Only the link is clicked");
      clicks.push({ href: this.href, download: this.download, connected: this.isConnected });
    });
    vi.useFakeTimers();
    try {
      browserPgnDelivery.download(PGN, GAME_ID);
      expect(clicks).toEqual([
        { href: OBJECT_URL, download: "neurochess-" + GAME_ID + ".pgn", connected: true },
      ]);
      expect(document.querySelector("a[download]")).toBeNull();
      vi.advanceTimersByTime(999);
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    } finally {
      vi.useRealTimers();
    }
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe("application/x-chess-pgn;charset=utf-8");
    await expect(blob.text()).resolves.toBe(PGN);
  });
});
