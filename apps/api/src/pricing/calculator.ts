import {
  type AiProvider,
  type BillingDimensions,
  billingUsageSchema,
  type CostEstimate,
  type CostUnavailableReason,
  type PricingSnapshot,
  pricingSnapshotSchema,
} from "@neurochess/contracts";

import { priceCatalogue } from "./catalogue.js";

export type PinnedPricing =
  | { status: "available"; pricing: PricingSnapshot }
  | { status: "unavailable"; reason: CostUnavailableReason };

export function pinPricing(provider: AiProvider, modelId: string): PinnedPricing {
  if (provider === "openrouter") return { status: "unavailable", reason: "routing_price_unknown" };
  const entry = priceCatalogue.find(
    (price) => price.provider === provider && price.modelId === modelId,
  );
  if (!entry) return { status: "unavailable", reason: "model_price_unknown" };
  const parsed = pricingSnapshotSchema.safeParse(entry);
  return parsed.success
    ? { status: "available", pricing: parsed.data }
    : { status: "unavailable", reason: "pricing_invalid" };
}

export function calculateCost(pinned: PinnedPricing, rawBilling: unknown): CostEstimate {
  const unavailable = (reason: CostUnavailableReason): CostEstimate => ({
    status: "unavailable",
    reason,
  });
  if (pinned.status === "unavailable") return unavailable(pinned.reason);
  const price = pricingSnapshotSchema.safeParse(pinned.pricing);
  if (!price.success) return unavailable("pricing_invalid");
  if (rawBilling == null) return unavailable("usage_missing");
  const parsed = billingUsageSchema.safeParse(rawBilling);
  if (!parsed.success) return unavailable("usage_invalid");
  const billing = parsed.data;
  if (billing.status === "unavailable") return unavailable(billing.reason);
  if (billing.provider !== price.data.provider) return unavailable("model_unknown");
  if (billing.pricingMatch !== "standard") {
    return unavailable(
      billing.pricingMatch === "routing_unknown" ? "routing_price_unknown" : billing.pricingMatch,
    );
  }
  let picoDollars = 0n;
  for (const [dimension, rate] of Object.entries(price.data.rates)) {
    if (rate === undefined) continue;
    const count = billing.dimensions[dimension as keyof BillingDimensions];
    if (count == null) return unavailable("usage_incomplete");
    // Rates have at most six decimals in USD/million tokens. Multiplying the
    // scaled rate by integer tokens gives exact pico-USD, with no rounding.
    const [whole = "0", fraction = ""] = rate.split(".");
    const scaledRate = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
    picoDollars += BigInt(count) * scaledRate;
  }
  const amount = `${picoDollars / 1_000_000_000_000n}.${(picoDollars % 1_000_000_000_000n).toString().padStart(12, "0")}`;
  return { status: "estimated", amount, currency: "USD", pricing: price.data };
}
