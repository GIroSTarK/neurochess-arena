import assert from "node:assert/strict";

import {
  createAlertEvaluator,
  deriveSignals,
  ociMetrics,
  parseSnapshot,
  renderDashboard,
} from "../../scripts/monitoring/policy.ts";

export async function operationsSnapshot(compose) {
  const text = await compose(
    "exec",
    "-T",
    "api",
    "node",
    "-e",
    "fetch('http://127.0.0.1:3001/internal/operations').then(async r=>{if(!r.ok)throw Error();process.stdout.write(await r.text())}).catch(()=>process.exit(1))",
  );
  const snapshot = parseSnapshot(JSON.parse(text));
  assert(snapshot, "Compiled API did not expose valid private operations");
  return snapshot;
}

export function verifyAlertDrill(alert, fault, recovery, previous = recovery) {
  const now = Date.now();
  const context = {
    now,
    edgeAvailable: true,
    diskUsedPercent: 10,
    backup: { status: "success", completedAt: new Date(now).toISOString() },
    backupMaxAgeSeconds: 3600,
  };
  const failed = deriveSignals(fault, previous, context);
  const recovered = deriveSignals(recovery, recovery, context);
  const evaluate = createAlertEvaluator();
  let last;
  // Exercise real fault samples through the production policy; advance only its clock.
  for (let seconds = 0; seconds <= 120; seconds += 60) {
    last = evaluate(failed, now + seconds * 1000);
  }
  assert.equal(last.active[alert], true, `${alert} did not fire`);
  assert(renderDashboard(failed, last.active, now).includes(`${alert}: FIRING`));
  assert(
    ociMetrics("ocid1.compartment.oc1..fixture", failed, last.active, now).some(
      (metric) => metric.name === alert && metric.datapoints[0].value === 1,
    ),
  );
  assert(
    evaluate(recovered, now + 180_000).transitions.some(
      (event) => event.alert === alert && event.state === "resolved",
    ),
  );
  return renderDashboard(failed, last.active, now);
}

export async function providerTimeoutDrill(compose, baseline) {
  const text = await compose(
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    `
    import { createOperations } from './apps/api/dist/monitoring/operations.js';
    import { invokeMove } from './apps/api/dist/providers/invoke-move.js';
    const operations = createOperations();
    operations.gauge('databaseReady',1);
    const adapter = { provider: 'openai', requestMove: () => new Promise(() => {}) };
    for(let i=0;i<3;i++) {
      const controller = new AbortController();
      setTimeout(()=>controller.abort(new DOMException('private-timeout-canary','TimeoutError')),20);
      const result = await invokeMove(adapter, { signal: controller.signal, apiKey: 'private-key-canary' }, operations);
      if(result.ok || result.error.code !== 'provider_timeout') throw Error('Timeout classification');
    }
    process.stdout.write(JSON.stringify(operations.snapshot()));
  `,
  );
  assert(!text.includes("canary"));
  const sample = JSON.parse(text);
  const zero = {
    ...baseline,
    counters: Object.fromEntries(Object.keys(baseline.counters).map((key) => [key, 0])),
  };
  verifyAlertDrill("ProviderFailures", sample, baseline, zero);
}
