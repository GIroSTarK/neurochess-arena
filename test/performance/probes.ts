import type { Browser, Page } from "@playwright/test";

export interface WorkerMeasurements {
  created: number;
  live: number;
  peak: number;
  startupMs: number[];
  searches: { start: number; end: number | null }[];
  paints: number[];
}

declare global {
  interface Window {
    arenaMeasurements: WorkerMeasurements;
  }
}

// Instrument only counts and timing; never retain UCI, positions, requests or credentials.
export async function instrument(page: Page) {
  await page.addInitScript(() => {
    const metrics: WorkerMeasurements = {
      created: 0,
      live: 0,
      peak: 0,
      startupMs: [],
      searches: [],
      paints: [],
    };
    window.arenaMeasurements = metrics;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private stopped = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        metrics.created++;
        metrics.live++;
        metrics.peak = Math.max(metrics.peak, metrics.live);
        const created = performance.now();
        let ready = false;
        this.addEventListener("message", (event: MessageEvent<unknown>) => {
          if (typeof event.data !== "string") return;
          if (!ready && event.data.trim() === "readyok") {
            ready = true;
            metrics.startupMs.push(performance.now() - created);
          }
          if (event.data.startsWith("bestmove")) {
            const search = metrics.searches.at(-1);
            if (search?.end === null) search.end = performance.now();
          }
        });
      }
      override postMessage(message: unknown) {
        if (typeof message === "string" && message.startsWith("go ")) {
          metrics.searches.push({ start: performance.now(), end: null });
        }
        super.postMessage(message);
      }
      override terminate() {
        if (!this.stopped) {
          this.stopped = true;
          metrics.live--;
        }
        super.terminate();
      }
    };
    new MutationObserver((records) => {
      if (records.some((record) => record.attributeName === "data-fen")) {
        const updated = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => metrics.paints.push(performance.now() - updated)),
        );
      }
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-fen"] });
  });
}

export async function workerProbe(browser: Browser) {
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets");
  const target = targetInfos.find(
    (item) => item.type === "worker" && item.url.includes("stockfish-19-lite-single.js"),
  );
  if (!target) throw new Error("Stockfish worker target not found");
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: false,
  });
  let sequence = 0;
  async function send<T>(method: string, params = {}): Promise<T> {
    const id = ++sequence;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cdp.off("Target.receivedMessageFromTarget", receive);
        reject(new Error(`Worker probe timed out: ${method}`));
      }, 10_000);
      function receive(event: { sessionId: string; message: string }) {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message) as {
          id?: number;
          result: T;
          error?: { message: string };
        };
        if (message.id !== id) return;
        clearTimeout(timer);
        cdp.off("Target.receivedMessageFromTarget", receive);
        if (message.error) reject(new Error(`Worker probe failed: ${method}`));
        else resolve(message.result);
      }
      cdp.on("Target.receivedMessageFromTarget", receive);
    });
    await cdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id, method, params }),
    });
    return response;
  }
  return {
    heap: () =>
      send<{ usedSize: number; totalSize: number; backingStorageSize: number }>(
        "Runtime.getHeapUsage",
      ),
    async startCpu() {
      await send("Profiler.enable");
      await send("Profiler.start");
    },
    async stopCpu() {
      const { profile } = await send<{
        profile: {
          startTime: number;
          endTime: number;
          nodes: { id: number; callFrame: { functionName: string } }[];
          samples: number[];
          timeDeltas: number[];
        };
      }>("Profiler.stop");
      const idle = new Set(
        profile.nodes
          .filter((node) => node.callFrame.functionName === "(idle)")
          .map((node) => node.id),
      );
      const activeUs = profile.samples.reduce(
        (sum, id, index) => sum + (idle.has(id) ? 0 : (profile.timeDeltas[index] ?? 0)),
        0,
      );
      return {
        sampledActiveMs: activeUs / 1000,
        elapsedMs: (profile.endTime - profile.startTime) / 1000,
        activeRatio: activeUs / (profile.endTime - profile.startTime),
      };
    },
    close: () => cdp.detach(),
  };
}

export async function visibility(page: Page, state: "visible" | "hidden") {
  // Headless tabs do not model OS backgrounding. Exercise the application's real event handler.
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}
