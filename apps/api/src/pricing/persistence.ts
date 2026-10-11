import {
  billingUsageSchema,
  type CostEstimate,
  costEstimateSchema,
  costUnavailableReasonSchema,
  pricingSnapshotSchema,
} from "@neurochess/contracts";
import type { StoredModelInvocation } from "@neurochess/database";

import type { PinnedPricing } from "./calculator.js";

export function pricingColumns(pinned: PinnedPricing) {
  return {
    pricingVersion: pinned.status === "available" ? pinned.pricing.version : null,
    pricingSource: pinned.status === "available" ? pinned.pricing.source : null,
    pricingCheckedAt: pinned.status === "available" ? pinned.pricing.checkedAt : null,
    pricingRates: pinned.status === "available" ? pinned.pricing.rates : null,
    pricingUnavailableReason: pinned.status === "unavailable" ? pinned.reason : null,
  };
}

export function storedPricing(attempt: StoredModelInvocation): PinnedPricing {
  if (attempt.pricingVersion === null) {
    const reason = costUnavailableReasonSchema.safeParse(attempt.pricingUnavailableReason);
    return { status: "unavailable", reason: reason.success ? reason.data : "pricing_invalid" };
  }
  const pricing = pricingSnapshotSchema.safeParse({
    version: attempt.pricingVersion,
    provider: attempt.provider,
    modelId: attempt.modelId,
    source: attempt.pricingSource,
    checkedAt: attempt.pricingCheckedAt,
    rates: attempt.pricingRates,
    currency: attempt.costCurrency,
    unit: "usd_per_million_tokens",
    basis: "standard_list_price",
  });
  return pricing.success
    ? { status: "available", pricing: pricing.data }
    : { status: "unavailable", reason: "pricing_invalid" };
}

export function readCost(attempt: StoredModelInvocation): CostEstimate {
  if (attempt.costAmount === null) {
    const reason = costUnavailableReasonSchema.safeParse(attempt.costUnavailableReason);
    return { status: "unavailable", reason: reason.success ? reason.data : "pricing_invalid" };
  }
  const pinned = storedPricing(attempt);
  if (pinned.status === "unavailable") return pinned;
  const parsed = costEstimateSchema.safeParse({
    status: "estimated",
    amount: attempt.costAmount,
    currency: attempt.costCurrency,
    pricing: pinned.pricing,
  });
  return parsed.success ? parsed.data : { status: "unavailable", reason: "pricing_invalid" };
}

export function readBilling(raw: unknown) {
  if (raw == null) return null;
  const parsed = billingUsageSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : ({ status: "unavailable", reason: "usage_invalid" } as const);
}
