ALTER TABLE "model_invocations" ADD COLUMN "billing_usage" jsonb;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "pricing_version" text;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "pricing_source" text;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "pricing_checked_at" date;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "pricing_rates" jsonb;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "pricing_unavailable_reason" text DEFAULT 'legacy_record';--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "cost_amount" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "cost_currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "cost_unavailable_reason" text DEFAULT 'legacy_record';--> statement-breakpoint
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_price_check" CHECK ((
      ("model_invocations"."pricing_version" is null and "model_invocations"."pricing_source" is null and "model_invocations"."pricing_checked_at" is null and "model_invocations"."pricing_rates" is null
        and "model_invocations"."pricing_unavailable_reason" in ('legacy_record', 'model_price_unknown', 'routing_price_unknown', 'pricing_invalid'))
      or ("model_invocations"."pricing_version" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{1,4}$'
        and "model_invocations"."pricing_source" in (
          'https://developers.openai.com/api/docs/models/gpt-4.1-mini',
          'https://developers.openai.com/api/docs/models/gpt-5-mini',
          'https://platform.claude.com/docs/en/about-claude/pricing',
          'https://ai.google.dev/gemini-api/docs/pricing')
        and "model_invocations"."pricing_checked_at" is not null and jsonb_typeof("model_invocations"."pricing_rates") = 'object'
        and octet_length("model_invocations"."pricing_rates"::text) <= 512 and "model_invocations"."pricing_unavailable_reason" is null)
      ) is true);--> statement-breakpoint
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_cost_check" CHECK (("model_invocations"."cost_currency" = 'USD' and (
      ("model_invocations"."cost_amount" is null and "model_invocations"."cost_unavailable_reason" in (
        'legacy_record', 'dispatch_unknown', 'model_price_unknown', 'routing_price_unknown',
        'usage_missing', 'usage_incomplete', 'usage_invalid', 'model_unknown', 'tier_unknown',
        'unsupported_dimensions', 'pricing_invalid'))
      or ("model_invocations"."cost_amount" >= 0 and "model_invocations"."cost_amount" <> 'NaN'::numeric and "model_invocations"."cost_unavailable_reason" is null
        and "model_invocations"."pricing_version" is not null and "model_invocations"."billing_usage" is not null and "model_invocations"."outcome" not in ('in_flight', 'interrupted'))
      )) is true);--> statement-breakpoint
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_billing_check" CHECK ("model_invocations"."billing_usage" is null or (
      jsonb_typeof("model_invocations"."billing_usage") = 'object' and octet_length("model_invocations"."billing_usage"::text) <= 2048
      and "model_invocations"."outcome" not in ('in_flight', 'interrupted')));