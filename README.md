# git-relay-server (v2-only Transport Migration Guide)

This guide covers server-side migration to relay transport encryption `v2` only.

Scope of this guide:
- Server runs with `TRANSPORT_CRYPTO_MODE=v2`
- Legacy shared symmetric transport key (`ENCRYPTION_KEY`) is not used
- No backward compatibility for v1 clients

## Prerequisites

- Deploy code version that includes v2 transport decryption support (`X25519` + AES-256-GCM)
- All CLI clients are migrated to v2 and can pin/import server public key
- PM2 is used with `ecosystem.config.cjs`

## Step 1: Generate X25519 key pair (server transport key)

Generate a new private key and public key on a secure machine:

```bash
openssl genpkey -algorithm X25519 -out relay-transport-v2-private.pem
openssl pkey -in relay-transport-v2-private.pem -pubout -out relay-transport-v2-public.pem
```

Choose a key id (`kid`) for this key pair, for example:

```bash
export TRANSPORT_KEY_ID="relay-v2-2026-02"
```

## Step 2: Prepare private key for env injection (escaped newlines)

`git-relay-server` accepts `TRANSPORT_PRIVATE_KEY_PEM` with escaped `\n`.

Convert PEM to a single-line escaped string:

```bash
awk '{printf "%s\\\\n", $0}' relay-transport-v2-private.pem
```

Copy the output and use it as the value of `TRANSPORT_PRIVATE_KEY_PEM`.

## Step 3: Distribute public key out-of-band to CLI operators

Do not send private key to clients.

Share these to CLI operators through a trusted channel:
- `kid` (same as `TRANSPORT_KEY_ID`)
- Public key PEM (`relay-transport-v2-public.pem`)
- Optional fingerprint (`sha256:...`) for verification

CLI side should pin/import the public key (example command shown for coordination only):

```bash
aw relay config import-public-key --key-id "$TRANSPORT_KEY_ID" --file relay-transport-v2-public.pem
```

## Step 4: Configure server env (v2-only)

Set server env vars with `TRANSPORT_CRYPTO_MODE=v2`.

Required for v2-only transport:
- `TRANSPORT_CRYPTO_MODE=v2`
- `TRANSPORT_KEY_ID=<kid>`
- `TRANSPORT_PRIVATE_KEY_PEM=<escaped-private-pem>`
- `TRANSPORT_REPLAY_TTL_MS` (recommended keep default `300000`)
- `TRANSPORT_CLOCK_SKEW_MS` (recommended keep default `30000`)

Existing required server envs still apply:
- `API_KEY`
- `GITHUB_PAT`
- `GIT_AUTHOR_NAME`
- `GIT_AUTHOR_EMAIL`
- optional `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`
- optional `PORT`, `REPOS_DIR`, `SESSION_TTL_MS`

Not needed in v2-only mode:
- `ENCRYPTION_KEY`

## Step 5: Update PM2 config (`ecosystem.config.cjs`)

Add placeholder entries for the new `TRANSPORT_*` envs in:
- `workspaces/k/misc/git-relay-server/ecosystem.config.cjs`

This repo file should keep placeholders only (no real secrets committed).

## Step 6: Restart service with PM2

Build and restart:

```bash
npm run build
pm2 reload ecosystem.config.cjs --update-env
```

If the process is not running yet:

```bash
pm2 start ecosystem.config.cjs --update-env
```

## Step 7: Verify startup and health

Check PM2 logs for config validation errors:

```bash
pm2 logs git-relay-server --lines 200
```

Check health endpoint:

```bash
curl http://127.0.0.1:3000/health
```

Expected result:
- Process starts successfully
- No missing env var errors for `TRANSPORT_KEY_ID` / `TRANSPORT_PRIVATE_KEY_PEM`
- Health endpoint returns OK JSON

## Step 8: Validate v2-only behavior

Run one end-to-end push from a migrated CLI client.

Expected result:
- v2 client requests succeed
- v1 clients fail (by design) because server is configured as `v2` only

## Troubleshooting

- `Missing required env vars: TRANSPORT_KEY_ID, TRANSPORT_PRIVATE_KEY_PEM`
  - PM2 env not updated or placeholders not replaced in runtime config.
- `Invalid TRANSPORT_CRYPTO_MODE`
  - Use one of: `v1`, `compat`, `v2`. For this guide, use `v2`.
- `Unknown transport key id`
  - CLI pinned `kid` does not match server `TRANSPORT_KEY_ID`.
- `Decryption failed` / integrity error
  - Wrong public/private key pair, corrupted PEM formatting, or copied escaped private key incorrectly.
- Replay errors (`nonce already used`)
  - Retries are reusing the same encrypted payload blob; client should re-encrypt per request.

## Security Notes

- Treat `TRANSPORT_PRIVATE_KEY_PEM` as a secret.
- Rotate key pair by generating a new X25519 key pair and redistributing the new public key + `kid`.
- Current replay nonce cache is in-memory (resets on process restart).
