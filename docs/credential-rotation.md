# Saved-credential encryption-key rotation

This is an operator-run maintenance procedure for the single configured AES-GCM key in [ADR-0014](decisions/0014-encrypted-provider-credentials.md). It changes encrypted envelopes, not users' provider keys. Keep every API writer stopped until the database and deployment configuration agree. Never reuse a key ID for different material, rotate through the online API, or start old and new API instances together.

## Preconditions and recovery material

Use a reviewed release containing `apps/api/dist/credentials/rotate-cli.js`, the [production deployment configuration](operations.md#artifacts-and-rollout), and Node 24 on the operator host. Commands below run from that release checkout on the Linux deployment host as its authorized operator. Use the actual Compose project name if it differs from `neurochess`. After [recovery promotion](recovery.md#promote-the-recovered-volume), include `-f deploy/recovery/promote.override.yml` on **every** Compose command below; retain the selected volume and recovered database URL.

Before scheduling the outage:

- Verify independent recovery of the current key **and its exact ID**, the current API environment file, and the database backup decryption identity. Retain the old pair until every backup requiring it has actually expired and incident holds are resolved. The [backup policy](recovery.md#prepare-independent-secret-recovery) owns retention and access controls.
- Rehearse this procedure and reversal against an isolated restored database with the matching release. Establish a maintenance window from the representative row count, database size and measured runtime. The tool batches 250 rows in memory but commits the entire table once; allow transaction/WAL/disk capacity for that operation.
- Record the release/image IDs, current `API_ENV_FILE` path, old/new key IDs, backup identity and aggregate checks in private maintenance evidence. Do not record keys, envelopes, account IDs, connection strings or provider responses. Disable shell tracing and terminal recording when handling secrets.

## Stop writers and prepare the new pair

Stop the monitor and backup timer so they cannot introduce database clients during maintenance. If the backup service is already running, let it finish and confirm it is inactive. Stop all API owners, migrations, other SQL clients and ad hoc jobs; keep PostgreSQL running. The example assumes the installed service names from the operations/recovery runbooks.

```sh
systemctl stop neurochess-monitor.service neurochess-backup.timer
systemctl is-active neurochess-backup.service
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml stop web api
docker inspect neurochess-api --format '{{.State.Running}} {{.State.ExitCode}}'
node scripts/recovery/run.ts backup /etc/neurochess/backup.json
```

The backup service must report `inactive`; that check normally exits nonzero. The API must report `false 0`; investigate a failed drain before continuing. Confirm there are no other deployments connected to this database. Require the manual encrypted backup/readback to succeed and record its identity before rotation. A missing key, failed backup or unavailable independent recovery copy blocks the procedure.

Create a private transient directory. The script reads the current API file selected by the deployment configuration, generates a new random 32-byte key, and creates a mode-0600 manifest without printing values. Replace the **non-secret** new ID below with a never-before-used ID. Existing files cause an error rather than being overwritten.

```sh
umask 077
install -d -m 0700 /run/neurochess-rotation
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const deployment = parseEnv(readFileSync('/etc/neurochess/deploy.env', 'utf8'));
const environment = parseEnv(readFileSync(deployment.API_ENV_FILE, 'utf8'));
const manifest = {
  confirm: 'rotate-provider-credentials-v1',
  old: {
    keyId: environment.CREDENTIAL_ENCRYPTION_KEY_ID,
    key: environment.CREDENTIAL_ENCRYPTION_KEY,
  },
  next: {
    keyId: 'provider-keys-2026-rotation1',
    key: randomBytes(32).toString('base64'),
  },
};
writeFileSync('/run/neurochess-rotation/keys.json', JSON.stringify(manifest), {
  mode: 0o600, flag: 'wx',
});
JS
```

Import the new pair into the deployment secret store and the separate encrypted recovery store through their protected interfaces. Retrieve and compare it in a separate operator session before proceeding; a file only in `/run` is not recoverable after a host restart. Keep the old pair recoverable too. Never paste either key into command arguments, shell history, chat or logs.

## Authenticate, rotate and verify

The one-shot container uses the manifest owner's numeric UID/GID to read its mode-0600 mount with all capabilities dropped. It inherits the existing verified-TLS database connection and public certificate from the deployment's `migrate` service. It starts no API server and calls no providers. Do not use `docker compose config` without `--quiet`, or inspect the full container environment.

```sh
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml run --rm --no-deps \
  --user "$(stat -c '%u:%g' /run/neurochess-rotation/keys.json)" \
  -v /run/neurochess-rotation/keys.json:/rotation-keys.json:ro \
  migrate node apps/api/dist/credentials/rotate-cli.js verify-old /rotation-keys.json

docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml run --rm --no-deps \
  --user "$(stat -c '%u:%g' /run/neurochess-rotation/keys.json)" \
  -v /run/neurochess-rotation/keys.json:/rotation-keys.json:ro \
  migrate node apps/api/dist/credentials/rotate-cli.js rotate /rotation-keys.json

docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml run --rm --no-deps \
  --user "$(stat -c '%u:%g' /run/neurochess-rotation/keys.json)" \
  -v /run/neurochess-rotation/keys.json:/rotation-keys.json:ro \
  migrate node apps/api/dist/credentials/rotate-cli.js verify-new /rotation-keys.json
```

Run each command only after the preceding command succeeds. Each success emits only `credential_maintenance`, `status: success` and an aggregate `rows` count; require the same count from all three commands. Failure exits nonzero with a fixed status, never the underlying exception. Keep services stopped after any failure and use the interruption procedure below.

Each operation refuses other existing database client connections, then takes an exclusive credential-table lock. The lock also excludes later writers during its transaction; it cannot prevent an incorrectly restarted API writing after commit. Rotation authenticates each old envelope with its owner, provider and credential ID, writes a fresh nonce/tag/ciphertext under the new ID, verifies returned plaintext matches, and authenticates the entire resulting table before commit. Owner IDs, credential IDs, providers, labels, suffixes and timestamps remain unchanged. Unknown IDs, mixed keys, malformed/tampered rows and SQL errors abort the entire transaction. Lock waits time out after five seconds; individual SQL statements and idle transaction intervals after thirty seconds. Do not weaken these bounds to conceal an unexpected client or stalled database.

## Switch configuration and reopen

After successful verification, create a new protected API environment file. This script preserves all other settings and requires exactly one occurrence of each encryption setting; it does not change the running deployment selection. Choose an unused output filename if `api-rotated.env` already exists.

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const deployment = parseEnv(readFileSync('/etc/neurochess/deploy.env', 'utf8'));
const keys = JSON.parse(readFileSync('/run/neurochess-rotation/keys.json', 'utf8'));
let environment = readFileSync(deployment.API_ENV_FILE, 'utf8');
for (const [name, value] of [
  ['CREDENTIAL_ENCRYPTION_KEY_ID', keys.next.keyId],
  ['CREDENTIAL_ENCRYPTION_KEY', keys.next.key],
]) {
  const pattern = new RegExp(`^${name}=.*$`, 'gm');
  if ([...environment.matchAll(pattern)].length !== 1) throw new Error('INVALID_API_CONFIGURATION');
  environment = environment.replace(pattern, `${name}=${value}`);
}
writeFileSync('/etc/neurochess/api-rotated.env', environment, { mode: 0o600, flag: 'wx' });
JS
```

Set `API_ENV_FILE=/etc/neurochess/api-rotated.env` in the protected `/etc/neurochess/deploy.env` using the operator's editor. Preserve the original file/path for rollback. Confirm the selected key pair matches the independently stored new version without displaying values. Then recreate the API so it receives the new environment; a container `restart` retains its old environment.

```sh
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml config --quiet
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml up -d --wait --force-recreate api
node scripts/recovery/run.ts backup /etc/neurochess/backup.json
docker compose --env-file /etc/neurochess/deploy.env -f deploy/compose.yml up -d web
systemctl start neurochess-monitor.service neurochess-backup.timer
```

Require readiness and the new encrypted backup/readback before reopening the web service. Record that backup's new key version. Through the normal authenticated UI, check metadata and an operator-owned saved credential with a provider-model discovery request; this checks authorization and decrypt/dispatch without executing a chess turn. Do not use another user's credential, print a key or create billable inference merely to test rotation. A provider outage is distinct from a decryption failure; keep it explicit in the maintenance evidence. AI games resume only through their existing user-directed recovery, and room clients resynchronize normally.

After verification and independent recovery checks, remove the exact temporary manifest with `rm -- /run/neurochess-rotation/keys.json` and remove the empty directory with `rmdir /run/neurochess-rotation`. Apply the existing secret retention policy to the old environment file; retain recoverable old key versions separately. File deletion does not guarantee erasure from storage snapshots.

## Interruption and rollback

Keep every writer stopped. An interrupted transaction rolls back when PostgreSQL closes its connection, but a lost acknowledgement during `COMMIT` leaves the operator uncertain whether it committed. Confirm the one-shot container has exited and its database connection is gone before running either verifier. If the host restarted, restore the exact old/new manifest from independent secret storage; do not generate replacement material for either ID.

Run the same `verify-old` and `verify-new` commands above independently, even if the first fails. Interpret only successful whole-table authentication:

| Result                                                               | Action while writers remain stopped                                                                                                                                                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old succeeds with a positive count; new fails                        | Rotation did not commit. Keep the old API configuration and reopen, or resolve the cause and retry rotation.                                                                                               |
| New succeeds with a positive count; old fails                        | Rotation committed. Complete the new configuration switch, or reverse it as below. Repeating `rotate` deliberately fails.                                                                                  |
| Both succeed with zero rows                                          | The table is empty. Select one retained pair explicitly and make deployment configuration and the maintenance record agree.                                                                                |
| Neither succeeds, counts disagree, or both succeed with nonzero rows | Keep service closed. Check target database/release, manifest recovery, connection conflicts and integrity in an isolated copy. Do not edit/delete failing rows or assume a partial rotation is acceptable. |

To reverse a committed rotation, first run `verify-new` with all writers stopped and record its current row count as the rollback baseline. Use the same one-shot command with `rollback` in place of `rotate`, then run `verify-old`; require both commands to succeed with that baseline count. This re-encrypts every row from the new key to the original key in one transaction with the same authentication/readback checks; ciphertext/nonces will differ from the original backup. Restore `API_ENV_FILE` to the retained original path, recreate the API, back up and reopen using the steps above. A failed reversal leaves the new-key rows intact unless its commit acknowledgement was lost; rerun the verifiers to determine the actual state.

If service was already reopened, stop it and its other clients again before obtaining that baseline. New saves and revocations can legitimately change the count; compare with the original rotation count only when writers were never reopened. Newly saved credentials under the new key are included; do not restore an old database snapshot over later saves or revocations to undo rotation. If a full restore becomes necessary, use [isolated recovery and privacy reconciliation](recovery.md#reconcile-and-validate-before-reopening) with that backup's matching key. Rotation cannot recover lost key material or revoke an exposed provider key upstream.

## Verification boundary

`npm run test:integration -- apps/api/test/credential-rotation.integration.test.ts` exercises synthetic PostgreSQL data: multi-batch rotation, owner-scoped IDs, metadata preservation, reverse rotation, repeat refusal, corrupt-row rollback, competing clients and database cancellation after an earlier row update. `npm run test:unit -- apps/api/src/credentials/rotate-cli.test.ts` checks fixed output for malformed input and uncaught errors. These checks do not establish live secret-store access, a production-sized maintenance window, host-loss recovery or a completed production rotation. Rehearse those deployment boundaries before release and retain dated evidence outside this runbook.
