# workerapt

A Cloudflare Worker that serves a signed APT repository, with `.deb` storage in R2 and per-distribution indices kept in a Durable Object.

## Advantages

- **No servers to run.** Worker + R2 + Durable Object — no VM, no nginx, no cron job rebuilding indices.
- **Cheap at rest.** `.deb` bytes live in R2 (no egress fees from Cloudflare's edge); Workers/DO storage scales to zero when idle.
- **Globally cached at the edge.** APT clients fetch through Cloudflare's network, not a single origin.
- **Indices stay consistent.** Each `dist` is its own Durable Object, so `Packages`, `Release`, `Release.gpg`, and `InRelease` are rebuilt and signed atomically per publish — no half-updated repo state.
- **Direct-to-R2 uploads.** The Worker hands out presigned PUT URLs, so large `.deb`s never stream through the Worker's request body limit.
- **No GPG keys on dev or CI machines.** The signing key lives only as a Worker secret after initial setup — publishes just hit an authenticated HTTP endpoint, so laptops and build runners never need `gpg` installed or a private key on disk.
- **Multi-tenant by path.** A single deployment hosts many repos (`/<repo>/...`), each with its own pool prefix and DO-backed dists.
- **Standards-compliant.** Output is plain APT (`deb [signed-by=...]`) — clients use stock `apt-get`, no custom transport.
- **One-line client setup.** `curl .../<repo>/setup | sh` writes the keyring and sources list.
- **Tiny upload tool.** `bin/workerapt-upload.mjs` is a single dependency-free Node file you drop into CI.

## Setup

### 1. Set the R2 bucket name in `wrangler.jsonc`

The R2 binding has no `bucket_name` yet — set it before deploying:

```jsonc
"r2_buckets": [
    {
        "binding": "POOL_BUCKET",
        "bucket_name": "your-bucket-name"
    }
]
```

Create the bucket first if it doesn't exist:

```sh
npx wrangler r2 bucket create your-bucket-name
```

### 2. Generate a GPG signing key and upload it as Worker secrets

Generate an unencrypted (no passphrase) signing key — the Worker can't prompt for one:

```sh
gpg --batch --gen-key <<EOF
%no-protection
Key-Type: RSA
Key-Length: 4096
Name-Real: Your Repo Name
Name-Email: repo@example.com
Expire-Date: 0
%commit
EOF
```

Export the armored keys:

```sh
gpg --armor --export repo@example.com         > repo-public.asc
gpg --armor --export-secret-keys repo@example.com > repo-private.asc
```

Push them, plus the rest of the required secrets, to the Worker:

```sh
npx wrangler secret put GPG_PUBLIC_KEY      < repo-public.asc
npx wrangler secret put GPG_PRIVATE_KEY     < repo-private.asc
npx wrangler secret put KEY                 # bearer token clients send to upload/publish
npx wrangler secret put ORIGIN              # e.g. "Your Repo"
npx wrangler secret put LABEL               # e.g. "your-repo"
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_BUCKET_NAME      # same value as bucket_name above
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

The R2 access key pair is for presigned PUT URLs — create it under R2 → Manage R2 API Tokens with read/write on the bucket.

Delete the local key files once the secrets are uploaded.

### 3. Deploy

```sh
npm install
npx wrangler deploy
```

## Uploading packages

Copy `bin/workerapt-upload.mjs` into your release pipeline (it's a single-file Node script with no dependencies beyond Node 18+) and run it against your built `.deb` files:

```sh
WORKERAPT_URL=https://workerapt.example.workers.dev \
WORKERAPT_KEY=<the KEY secret> \
node workerapt-upload.mjs \
    --repo myrepo \
    --dist stable \
    --cat main \
    dist/*.deb
```

The script hashes each `.deb`, asks the Worker for a presigned R2 URL, uploads directly to R2, then publishes the batch to the dist so the `Packages`, `Packages.gz`, `Release`, `Release.gpg`, and `InRelease` indices are regenerated and signed.

## Consuming the repo

Users add the repo with the helper served at `/<repo>/setup`:

```sh
curl -fsSL https://workerapt.example.workers.dev/myrepo/setup | sh
sudo apt-get install your-package
```

Override `dist` / `component` via query string: `/myrepo/setup?dist=stable&component=main`.
