# Backup and recovery

The deployment owner selected a **24-hour recovery-point objective (RPO), two-hour recovery-time objective (RTO), daily backups and seven-day backup retention**. RPO measures the age of the database snapshot; RTO runs from incident declaration through secret retrieval, isolated restore, privacy reconciliation, validation and the controlled service switch. These are operational targets, not an availability guarantee. The [deployment runbook](operations.md) defines the single API owner and $0 Oracle Frankfurt topology. Live bucket, secret-store, timer, capacity and notification verification follows the [release checklist](operations.md#mvp-release-acceptance); acceptance status is tracked in the [roadmap](roadmap.md#phase-5--analysis-polish-and-release-hardening).

## Retention and ownership

- Production guest access expires after 24 hours without renewal. Keep the existing renewal and [shared-room cleanup](product.md#shared-room-retention): expiry denies guest access immediately, makes guest-only terminal rooms eligible for cleanup, and never closes unfinished rooms or replaces seats. Expired solo guest records have no automatic purge; their physical retention remains a separate product decision.
- Database backups include private games, account/authentication records, encrypted provider credentials and private analysis. A backup can contain records subsequently deleted or credentials subsequently revoked. Live deletion does not rewrite an earlier backup, a downloaded PGN or an operator copy.
- The dedicated private OCI Standard bucket expires `database/` objects after seven days using `deploy/recovery/lifecycle.json`. Keep versioning **Disabled** so old versions do not outlive the policy. Expiry is eligibility for asynchronous cloud deletion, not a claim of immediate erasure at the seven-day boundary. Verify actual removal and investigate overdue objects daily; do not enable immutable retention rules or archive tiers that prevent the policy or delay recovery.
- No local archive history is retained. Each job removes its plaintext, encrypted staging copy and readback copy on completion/failure. An abrupt process/host failure may leave its private `running/` directory. Confirm the service is stopped before removing that exact directory and rerunning; never remove a lock belonging to a running job. File removal is not a secure-erasure guarantee for underlying storage or snapshots.
- Restrict the bucket, recovery identities, secret store, recovery hosts and operational records to the deployment owner and a specifically designated recovery operator. Application users and the API container get no backup access. Review access after an operator change. Do not create public buckets, preauthenticated links, web-served backup directories or CI dump uploads.

## Prepare independent secret recovery

Install Node 24 and **age 1.3.2** on the backup/recovery hosts, with the supported OCI CLI on the backup host. Use the upstream release appropriate to the host architecture, verify its release SHA-256 and retain the installation provenance. The automated drill downloads and verifies the Windows AMD64/Linux AMD64/ARM64 artifacts in a temporary directory; it does not install a global tool. [age releases](https://github.com/FiloSottile/age/releases/tag/v1.3.2), [age usage](https://github.com/FiloSottile/age#usage).

Generate a native age identity on the recovery operator's protected machine. Put only its public recipient on the production host:

```sh
umask 077
age-keygen -o backup-identity.txt
age-keygen -y backup-identity.txt > backup-recipients.txt
```

Store the identity in the operator's independent encrypted password manager and an encrypted offline recovery copy, accessible without the production VM or its OCI instance principal. Materialize it only on the isolated recovery host, preferably in `/run/neurochess-recovery` with directory mode 0700 and file mode 0600. The scheduled backup process never needs it. Do not place it in the database bucket, repository, images, logs or beside a dump.

Keep the complete deployment secret set recoverable independently in the deployment secret store and the operator's separate encrypted recovery store: `BETTER_AUTH_SECRET`, the exact `CREDENTIAL_ENCRYPTION_KEY_ID`/`CREDENTIAL_ENCRYPTION_KEY` pair, database passwords, SMTP/OAuth secrets and relevant certificate material. Record secret **version identifiers**, release commit, immutable API/web image IDs, migration journal identity and recipient fingerprint in a private deployment inventory; do not copy secret values into it. Keep each superseded secret version until every backup needing it has actually expired and any incident hold has been explicitly resolved. Test access to this store from a different operator session/device before activation.

Age protects the full database archive. The API's separate AES-GCM key protects saved provider credentials inside it. Losing either required decryption key makes its encrypted content unrecoverable. Do not generate replacement key material under an existing key ID. With a missing/wrong credential key, saved-key operations must report unavailable/authentication failure without dispatching inference; metadata and deletion remain usable. Users may explicitly save replacement provider keys. Follow the [offline credential-key rotation runbook](credential-rotation.md) for writer-stop, authenticated re-encryption, verification and deployment. Revoking a saved record does not revoke its key upstream: suspected compromise also requires revocation at the provider. An auth-secret change invalidates signed cookies but does not replace session/recovery-token reconciliation.

## Configure and run backups

Create a dedicated **private, non-versioned Standard bucket in Frankfurt** using the operator's identity. Grant the VM's instance principal bucket-scoped **`read buckets` (`BUCKET_READ`)**, required by both `GetBucket` and `GetObjectLifecyclePolicy`, plus object inspect/read/create for that bucket. `inspect buckets` alone cannot perform the job's checks. Restrict object permissions to `OBJECT_INSPECT`, `OBJECT_READ` and `OBJECT_CREATE`; do not grant overwrite/delete, bucket mutation, lifecycle editing or secret-store read access. Grant the regional Object Storage service the lifecycle permissions documented by OCI. [Required OCI permissions](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/objectstoragepolicyreference.htm). The operator configures the lifecycle once:

```sh
oci os object-lifecycle-policy put --namespace-name YOUR_NAMESPACE \
  --bucket-name neurochess-backups --region eu-frankfurt-1 \
  --from-json file://deploy/recovery/lifecycle.json
```

This replaces the policy for that dedicated bucket: inspect the existing policy first. The job checks private access, disabled versioning and the exact enabled seven-day rule before uploading. It checks the complete bounded object inventory and refuses to exceed **8 GiB** in this bucket. Dumps, ciphertext and readback are each capped at **1 GiB**, with a ten-minute deadline per subprocess and a 35-minute service deadline. Reserve at least 3 GiB of staging capacity. These are deliberate MVP limits; a larger database needs a reviewed capacity and recovery-target decision, not a removed limit. OCI's current Always Free allowance is 20 GB across the tenancy's object storage; confirm remaining aggregate capacity, requests and actual console pricing before activation. The bucket cap cannot measure unrelated tenancy usage. [OCI quotas](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [lifecycle policy and permissions](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/usinglifecyclepolicies.htm).

Copy `deploy/recovery/backup.example.json` to `/etc/neurochess/backup.json`, mode 0600. Set the actual PostgreSQL container name, namespace and bucket. Keep the database/role `neurochess`; this uses the container's local socket with the existing application role, without putting a database password in a process argument. Put the public recipient at the configured path. The root/operator-owned service needs Docker administration; filesystem hardening does not make Docker socket access unprivileged.

```sh
node scripts/recovery/run.ts backup /etc/neurochess/backup.json
install -m 0644 deploy/recovery/neurochess-backup.service /etc/systemd/system/
install -m 0644 deploy/recovery/neurochess-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now neurochess-backup.timer
systemctl list-timers neurochess-backup.timer
```

The timer runs at **02:00 UTC daily**, with a persistent catch-up after downtime. Run an additional backup before migrations or a consequential secret/configuration change and review the eight-GiB budget first. PostgreSQL `pg_dump --format=custom` takes a consistent database snapshot while writes continue; it does not capture changes committed after that snapshot, cluster roles or external secrets. Host/root administrators are trusted. [PostgreSQL 18 dump and restore](https://www.postgresql.org/docs/18/backup-dump.html).

The job encrypts before cloud upload, uses unique object names with no overwrite, verifies the upload checksum, downloads the encrypted object again and compares its SHA-256. Only then, after staging cleanup, does it atomically replace `/var/lib/neurochess-backup/status.json` with fixed status and UTC `startedAt`/`completedAt` timestamps. Child diagnostics and private data never go to the journal. The monitor uses snapshot-start age, with `backupMaxAgeSeconds: 86400`; older two-field evidence uses completion age for compatibility. A failed backup or readback emits failure evidence and preserves prior cloud copies. A killed/locked job is detected by stale evidence; monitor absence is independent. A slow daily job can breach the 24-hour target, which must alert rather than being concealed by a grace period.

Use the existing bounded monitoring journal namespace. Rehearse a denied upload in isolation, confirm `BackupFailure` firing and resolution after a good job, and verify real delivery to the owner. Monitor expiry, capacity, timer execution and separate secret recoverability as well as success timestamps. A successful backup is never sufficient recovery evidence.

## Restore into isolation

Declare the incident and preserve its time and the last known good release. Stop/drain the production API if it could still write; retain the original volume and images. Never restore onto it. Retrieve a trusted archive and its matching secret versions through the operator identity. Verify the inventory and encryption recipient; do not execute a dump from an untrusted source. PostgreSQL restore can execute source-controlled SQL. [Restore security](https://www.postgresql.org/docs/18/app-pgrestore.html).

Choose and record one recovery path before running commands:

- **Same-host storage recovery:** use the existing production host only when its OS, Docker daemon and storage are trusted and it has capacity for the untouched source volume, a separate restored volume and staging. The recovery Compose project isolates the restored database from the stopped production stack on that host.
- **Replacement-host recovery:** for a lost/untrusted VM or unavailable storage, provision a clean replacement following [host and network setup](operations.md#host-and-network), including the free-capacity constraint. Fence the old VM as described [below](#fence-the-previous-production-owner). The replacement hosts both the isolated restore and its eventual production stack. Docker named volumes are host-local; the promotion override does not transfer a volume between VMs.

In both paths, **recovery host** below means the selected host. Put the reviewed checkout at `/opt/neurochess`, install the [recovery tools](#prepare-independent-secret-recovery), and run commands from that checkout. Retrieve the backup's matching API/web images from the [independent artifact copy](operations.md#artifacts-and-rollout), plus the compatible rollback pair. Load the protected image archive with `docker image load --input <archive-path>` or pull the recorded immutable digests; compare image IDs and architecture with the inventory before use. A rebuild is a new candidate requiring validation, not evidence that the original image was recovered.

Use the deployment's [certificate/password setup](operations.md#secrets-and-database-tls) in a **new** private directory, `/etc/neurochess/recovery-secrets`, without overwriting the original secrets. New database passwords and a certificate for hostname `postgres` may be generated because the dump does not restore cluster roles; preserve the recovered auth/encryption secrets needed for validation. Set `SECRETS_DIR` in `/etc/neurochess/restore.env` to that directory. The dedicated recovery Compose artifact uses the pinned PostgreSQL 18 image, a new volume, the existing TLS initialization scripts and the `neurochess` role. Its database network is internal, with no published ports, no Caddy/API and the required isolation label:

```sh
docker compose --env-file /etc/neurochess/restore.env -f deploy/recovery/compose.yml config --quiet
docker compose --env-file /etc/neurochess/restore.env -f deploy/recovery/compose.yml up -d --wait
```

Keep this recovery project disconnected from production. Do not reuse a source volume or label a production container to bypass admission. Subsequent drills need a new project/volume; inspect the previous recovery resources before deliberately removing them.

Copy `deploy/recovery/restore.example.json` outside Git, supplying the isolated container, downloaded archive, protected staging directory and temporarily recovered age identity. Then run:

```sh
node scripts/recovery/run.ts restore /etc/neurochess/restore.json
```

The command validates the isolation label and network/port boundary, decrypts and authenticates the **entire** age stream before executing SQL, creates a unique `nc_restore_<uuid>` database from `template0` owned by `neurochess`, and uses `pg_restore --no-owner --no-privileges --exit-on-error --single-transaction`. It never uses `--clean`, replaces an existing database or starts an API. Wrong/missing age keys and damaged archives fail before database creation. SQL failures leave a new empty database for diagnosis, with the original database untouched. Its only success output is the generated database name and elapsed time. Remove failed isolated databases only after checking their exact identities; do not retry against a populated target.

The dedicated **isolated** `pg_hba.conf` permits the application role's recovered database over TLS. Configure an isolated API with that database, certificate/hostname verification and the recovered auth/encryption secret pair. Permit only a private operator connection; do not attach Caddy, public DNS, SMTP or provider egress. Use disposable adapters/mailboxes for synthetic drills. For actual restored data, keep inference/mail disabled by the recovery network, never by logging their payloads. Start with the backup's matching release image, compare the migration journal with the inventory, then apply the desired reviewed forward migrations with writers stopped. Run migrations again to check repeatability. Never down-migrate or start a binary incompatible with the restored schema.

## Reconcile and validate before reopening

Use the surviving authoritative database, independently retained privacy requests and operator incident records to establish every deletion/revocation after the snapshot. Do not create a new permanent application tombstone table or pretend the backup knows later changes. Before public access:

1. Use the isolated operator command below to reapply known account deletions, saved-credential revocations and terminal history deletions without needing users' passwords or sessions. It shares the application's account/history removal primitives, locks and room-retention rules: owned solo games and account records disappear, while the other room participant's entitlement and analysis survive. Do not directly delete a shared game to imitate access removal.
2. Reconcile upstream provider revocations and password/auth-method changes from authoritative evidence. The operator command invalidates every restored account session and database-backed recovery/OAuth token, and can expire specified guests and disable specified invitations. Before promotion, generate and independently store a **new `BETTER_AUTH_SECRET`** to invalidate stateless signed verification links and cookies too. Preserve the recovered credential-encryption key pair; it is independent of the auth secret. Users sign in again; never renew expired guests or reconstruct old invitation secrets.
3. If the post-snapshot record is incomplete, **keep the recovered data private**. Establish affected owners' deletion/revocation instructions or use the surviving authoritative database/forward repair. Do not infer consent from silence or a successful sign-in. This can exceed the RTO and is an incident to report; the two-hour target never authorizes resurfacing possibly deleted data.
4. Check migration identity and representative complete histories through the deterministic engine: all UCI moves legal, final FEN/result and canonical PGN matching; invocation counts/provenance and analysis prefixes preserved. Check account separation, removed room entitlements, opponent retained access and expired guest denial through the API, including replay/PGN/analysis. Test correct credential-key decryption through an authorized operation and safe failure with a wrong/missing key in a synthetic copy; never print a real credential.
5. Reopen unfinished AI games through explicit paused recovery with no automatic inference; require new controllers and user-directed continuation. Start one socket owner and verify that both room participants receive authoritative snapshots and can resynchronize after a restart. Guest expiry alone must not abort a room. Verify account/history/game deletion cascades in synthetic data, not by deleting real records merely for a check.

### Operator reconciliation

Copy `deploy/recovery/reconcile.example.json` to a protected `/etc/neurochess/reconcile.json`. Populate only established post-snapshot changes: `accounts` contains account UUIDs to delete, `history` contains `{ "userId": "UUID", "gameId": "UUID" }` entries, `credentials` contains `{ "userId": "UUID", "credentialId": "UUID" }`, `guests` contains identities to expire, and `invitations` contains room UUIDs to disable. Resolve history-clear requests into explicit game IDs from authoritative evidence. Keep confirmation `reconcile-isolated-restore-v1` and `invalidateSessions: true`. The manifest contains private identifiers: restrict it to mode 0600 and expire it with the incident record, never in Git or telemetry.

Stop all APIs and close operator SQL clients connected to the recovered database. Prepare `/etc/neurochess/recovered-api.env` with the new auth secret, recovered credential key pair and other API settings. Its `DATABASE_URL` must use the generated `nc_restore_*` database, the isolated database's application password, host `postgres`, `sslmode=verify-full` and `sslrootcert=/run/secrets/postgres-cert`. Run the reviewed API image as a one-shot operator process on the isolated network, using the actual public-certificate path:

```sh
docker run --rm --user "$(stat -c '%u:%g' /etc/neurochess/reconcile.json)" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --network neurochess-restore_database \
  --env-file /etc/neurochess/recovered-api.env -e RECOVERY_ISOLATED=true \
  -v /etc/neurochess/recovery-secrets/postgres-cert.pem:/run/secrets/postgres-cert:ro \
  -v /etc/neurochess/reconcile.json:/recovery-manifest.json:ro \
  neurochess-api:REVIEWED_RELEASE \
  node apps/api/dist/operations/reconcile-cli.js /recovery-manifest.json
```

The process uses the manifest's numeric owner UID/GID so it can read the mode-0600 file with all capabilities dropped. A different UID, including root without permission-bypass capabilities, cannot read that mount. Keep the mounted public certificate readable as described in the deployment runbook.

This command exposes no HTTP endpoint and never creates or impersonates a user session. It refuses ordinary database names or another client connection, validates a bounded strict manifest, and applies removals plus session/token invalidation atomically. It can be repeated after an uncertain acknowledgement. Account deletion aborts/anonymizes shared rooms through the canonical deterministic implementation. A history-deletion entry whose restored game is still unfinished fails the transaction: recover a later authoritative point or resolve its lifecycle explicitly while isolated, rather than fabricating post-snapshot moves/results. Unknown later changes still block public reopening.

Keep a private incident checklist containing the selected backup/release/secret **identifiers**, completed reconciliation decisions, aggregate counts, duration and pass/fail results. Exclude account/game contents, credentials and raw dumps from evidence. The owner signs off the reconciled restore before the following cutover. Keep the old volume private for diagnosis with an explicitly recorded short incident expiry; the switch does not erase it. Remove the temporary age identity and plaintext staging after validation, retaining the selected runtime secrets and their independent recovery copies.

### Fence the previous production owner

For **same-host recovery**, run the following on the existing production/recovery host using its **current** deployment configuration, before changing that configuration to the recovered volume. For **replacement-host recovery**, run it on the **old production host**, if reachable. The examples use the default project/container names; use the recorded names if different. If production already uses an adopted recovery volume, append its promotion override to the Compose command.

```sh
systemctl stop neurochess-backup.timer neurochess-backup.service neurochess-monitor
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml stop web api postgres
docker inspect neurochess-api neurochess-postgres-1 --format '{{.Name}} {{.State.Running}} {{.State.ExitCode}}'
```

Inspect all existing owners: they must be stopped, with API drain failures investigated. Confirm no backup job or collector remains active. An absent service/container is expected only when the inventory establishes that it was never installed or was already removed; do not silently treat an inspection error as successful fencing.

For **replacement-host recovery**, also stop the old VM through the OCI control plane, confirm its stopped state and prevent its restart. Keep its storage private for the incident-retention period. If SSH is unavailable, this confirmed control-plane stop is the required fence; changing DNS alone cannot stop old API writers, inference or cached-client traffic. Quarantine the old VM's network access and remove its instance-principal permissions before giving them to the replacement. If an old owner cannot be fenced, keep the restored service private.

On the **recovery host**, restrict HTTPS ingress to trusted operator/probe sources in OCI network rules during validation; preserve operator SSH and public TCP 80 for certificate challenges. Check all applicable IPv4/IPv6 rules rather than relying only on host firewall rules around Docker-published ports. The replacement's normal public ingress is enabled only after the checks below.

### Promote the recovered volume

Run every command in this section on the **recovery host**. For replacement-host recovery this becomes the new production host; do not run promotion against the old host's Docker daemon. Use `deploy/recovery/promote.override.yml` with the normal production Compose file. It mounts the **verified local recovered volume** in the production PostgreSQL service and applies the recovered-database HBA policy. The API/migrator then reach it as `postgres` on the production private database network with normal TLS verification.

Record the recovery volume's exact name:

```sh
docker inspect neurochess-restore-postgres --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}'
```

On a replacement host, prepare `/etc/neurochess/deploy.env` from `deploy/.env.example`; on the same host, preserve a protected copy of the previous configuration before editing it. Set `RECOVERED_VOLUME` to the verified name, `SECRETS_DIR` to `/etc/neurochess/recovery-secrets`, and `API_ENV_FILE` to `/etc/neurochess/recovered-api.env`. Keep the reviewed API/web image pair, original public origins and a non-overlapping proxy subnet/address. Ensure the recovered API file has the new auth secret, correct credential key pair and recovered database URL. Changing public origins would also require a new web build and OAuth configuration; it is outside this host replacement.

Stop any isolated validation API/SQL clients, then stop and inspect the recovery PostgreSQL owner:

```sh
docker compose --env-file /etc/neurochess/restore.env -f deploy/recovery/compose.yml stop postgres
docker inspect neurochess-restore-postgres --format '{{.Name}} {{.State.Running}}'
```

It must report `false`. The old production owner was separately fenced above; its containers are not expected on a clean replacement host. Never attach the same PostgreSQL data volume to two running servers. Validate and start the selected volume with the override:

```sh
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml -f deploy/recovery/promote.override.yml config --quiet
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml -f deploy/recovery/promote.override.yml up -d --wait postgres
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml -f deploy/recovery/promote.override.yml run --rm migrate
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml -f deploy/recovery/promote.override.yml up -d --wait api
```

Keep Caddy stopped while checking readiness and the selected database/journal identity through the private operator path. Do not publish the API/database ports. Store the new auth-secret version independently before creating a new backup.

### Restore routing, backups and monitoring

For **same-host recovery**, preserve the current DNS and Caddy data/config volumes. For **replacement-host recovery**, keep the original web/API hostnames and move both DNS A/AAAA records, or the recorded public IP assignment, to the replacement only after old-host fencing and private validation. Remove stale IPv6 routes too. Leave public HTTPS restricted during certificate issuance and acceptance. The new Caddy volumes can obtain fresh certificates: the default [HTTP ACME challenge](https://caddyserver.com/docs/automatic-https#http-challenge) needs public port 80 and correct DNS for both names. Do not copy untrusted old certificate keys after host compromise, disable TLS verification, or change API origins to temporary IP addresses.

On the **recovery host**, start Caddy with the selected recovered volume configuration:

```sh
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml -f deploy/recovery/promote.override.yml up -d web
```

From an allowed operator source, verify public certificate trust, both HTTPS origins, `/health` and `/ready`, the expected release/source download, real Stockfish loading and private WebSocket reconnect. For replacement-host checks, resolve both names to the new address explicitly until ordinary DNS agrees; use normal hostname/certificate validation. Confirm fresh sign-in can access a retained private game, old sessions fail, and reconciled deletions remain absent. Use dedicated test identities for SMTP/OAuth checks; keep inference user-directed. The old host stays fenced even while clients retain cached DNS.

On the **recovery host**, install/reactivate the [backup job](#configure-and-run-backups) and [monitoring service](operations.md#install-and-activate-monitoring). For a replacement, update the narrowly scoped OCI dynamic group to the new VM, verify bucket/metric permissions with its instance principal, and retain the existing private bucket, topic and alarm identities. Do not create duplicate alarms or leave two collectors publishing the same service dimension. Restore only the age **public recipient** to this host's scheduled backup configuration. Point `/etc/neurochess/backup.json` at the production PostgreSQL container and generated `nc_restore_*` database; keep the role `neurochess`. Update monitor container/origin/status paths and verify the timer is active.

Run a successful encrypted backup/readback from the promoted database and confirm the monitor sees fresh success evidence. Verify new-host metric ingestion, heartbeat, alarm firing/recovery and actual owner notification delivery. Old success timestamps or the previous VM's last heartbeat do not establish recovery. Only after these checks and owner sign-off, restore normal public HTTPS ingress and verify both origins from an independent public client. Record the recovered host/volume, image IDs, secret-version identifiers, routing change and measured RTO in the protected incident record.

### Subsequent rollout and rollback

**Include the promotion override on every subsequent production Compose command**, including rollout, restart, migration and rollback. Keep `RECOVERED_VOLUME`, the recovered database URL and backup target together in protected deployment configuration. Never restart the old recovery PostgreSQL container or use `down --volumes` on the recovery project: that project originally created the volume now serving production. Remove only its stopped container when decommissioning it; preserve the adopted volume. Future drills use fresh projects/volumes. A schema-compatible application rollback uses this same selected database and secrets, never the previous live volume.

For a failed migration/deployment, keep public ingress restricted and stop the candidate API before repair. Prefer a forward fix or the known compatible previous API/web pair against the **current recovered database and secrets**, following the [stop/inspect rollout](operations.md#artifacts-and-rollout) with the promotion override. Verify readiness, the schema journal, fresh sign-in, retained private history, old-session denial, sockets and the matching web artifact before reopening. If schema compatibility prevents application rollback, use a new isolated restore and repeat reconciliation. Never switch back to the original volume/old VM, reverse DNS to an unfenced stale writer, overlap socket owners or roll back SQL. The populated deployment rehearsal verifies restart and optional prior-image rollback; set `DEPLOY_ROLLBACK_API_IMAGE` to an actual reviewed prior image, not the same current image.

## Repeatable acceptance

First build the reviewed images with `npm run build:deployment:test`, then run `npm run test:recovery` with Docker, OpenSSL and network access to fetch the checksum-pinned age test tool. It provisions disposable PostgreSQL 18 source/target containers on internal networks, including the actual recovery Compose/TLS setup; fixture-only loopback relays connect the host test runner. Application fixtures use real API/auth/database services with injected providers and blocked fetch. Compiled reconciliation/promotion containers have no outbound network route; SMTP uses a deliberately unreachable fixture configuration. There is no public API or real inference/mail. The tests cover real dump/encryption/restore and separately recovered secrets; private legal history, invocations/analysis, key failure, AI recovery, sockets and cascades; reconciliation with expired sessions and retained opponent access; and the actual promotion override, fresh sign-in after auth-secret rotation, a private API read and a backup from the promoted database. They explicitly demonstrate that post-backup deletions reappear until reconciled. The OCI boundary is a local storage fixture; it does **not** establish live IAM, cloud durability or notification delivery.

The drill prints only aggregate archive bytes and backup/restore/recovery durations and fails above the agreed two-hour target. It verifies same-Docker-host volume adoption, not VM replacement or DNS/certificate cutover. Run it after relevant schema/credential/backup changes. Before launch and quarterly thereafter, rehearse both recovery paths, including replacement capacity, old-host fencing, independent image/secret/cloud retrieval, public routing/certificates, backup/monitoring reactivation and compatible rollback. Record revision, environment, representative data size and measured results in the change/incident evidence outside this canonical document. A small local synthetic drill does not establish full-size Oracle capacity or end-to-end disaster RTO. Preserve live checks as release gates until performed.
