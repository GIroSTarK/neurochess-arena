# ADR-0020: Single-host production deployment

**Status:** Accepted  
**Date:** 2026-10-14

## Context

The MVP has one in-process room socket owner, private PostgreSQL records and a static browser application with self-hosted Stockfish. A rolling deployment that temporarily starts a second API is incompatible with that ownership model. The owner selected **Oracle Cloud Always Free, Frankfurt, a $0 hosting budget and self-managed PostgreSQL**, accepting regional capacity limits and idle reclamation. This selects a deployment target; it does not provision infrastructure or approve public distribution.

## Decision

Use one Always Free-eligible Ampere A1 VM in the Frankfurt home region, Ubuntu 24.04 ARM64, Docker Engine and Compose. Run Caddy for static files and HTTPS termination, exactly one Fastify API container, and PostgreSQL 18 with a persistent volume. Only Caddy publishes HTTP/HTTPS ports. PostgreSQL uses an internal container network, SCRAM authentication, a dedicated application role and certificate/hostname-verified TLS. Host-only Secure cookies use sibling HTTPS origins on an owner-controlled domain.

Build the API and web images from the lockfile with Node 24.19.0 and the repository's npm 11.21.0 pin. Pin base-image manifest digests for AMD64 and ARM64. Keep secrets and certificates outside the checkout/images; keep the provider credential-encryption key separate from the database and recoverable through deployment secret storage. Ship the engine's exact source and notices in the static artifact under [ADR-0019](0019-browser-analysis-and-private-samples.md).

Deploy by stopping and draining the old API, confirming process exit, applying forward migrations once, and starting the new API before switching the web artifact. Accept a maintenance interval. Disable automatic updates, rolling replacements and API autoscaling. Room clients resynchronize; AI recovery remains explicit. Application rollback requires a schema-compatible image and the same auth/encryption secrets. Never roll back SQL or start old writers during migration.

The [operations runbook](../operations.md) owns commands, configuration, limits and release gates. The prepared SMTP path is Brevo's free transactional SMTP with mandatory TLS and an authenticated sender domain. OCI metrics and the application's health/readiness endpoints are the monitoring foundation; alert configuration and backup/restore operations remain separate milestones.

## Cost and service assumptions

Evidence checked on 2026-10-14:

- OCI documents 2 A1 OCPUs/12 GB RAM, 200 GB combined boot/block storage, five volume backups and limited object storage within Always Free. Availability is restricted to the tenancy's home region; idle compute can be reclaimed. Use only resources the actual console identifies as free. Domain registration, inference, quota overages and paid services are outside the $0 hosting assumption. [OCI Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- Brevo's free plan includes 300 daily sends; account admission, sender verification and delivery must be checked live. [Brevo plans](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans), [SMTP setup](https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP)

## Consequences

The same artifacts can move to a paid Linux VM without changing application boundaries. The operator owns OS/database maintenance, certificate renewal for PostgreSQL, capacity checks and recovery. One VM is a failure domain; there is no availability guarantee or zero-downtime rollout. Volume snapshots alone do not prove a consistent PostgreSQL restore. Reclamation, key loss and backup recovery remain release concerns, not problems hidden by the free price.

## Alternatives considered

- DigitalOcean VM plus managed PostgreSQL in Frankfurt reduces database administration; its starting VM/database prices exceed the selected budget. [VM pricing](https://www.digitalocean.com/pricing/droplets), [PostgreSQL pricing](https://www.digitalocean.com/pricing/managed-databases)
- Hetzner in Germany provides a low-cost VM with similar operations, but is paid. [Pricing](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- Render/Koyeb free compute plus Neon fits intermittent demos, with sleep, quotas and recovery limits. Default rolling replacements need additional coordination to preserve one socket owner. [Render free limits](https://render.com/docs/free), [Render deployment lifecycle](https://render.com/docs/deploys), [Koyeb instances](https://www.koyeb.com/docs/reference/instances), [Neon pricing](https://neon.com/pricing)
