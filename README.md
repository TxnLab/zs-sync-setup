# @txnlab/zs-sync-setup

Terminal setup for [ZeroSignal](https://zerosignal.ai) synced storage.

ZeroSignal can mirror your encrypted chat history into an S3-compatible bucket you own, so every device signed in with the same passkey converges on the same history. First-time bucket setup needs two steps a browser is not allowed to perform: creating the bucket, and installing the CORS rule that lets the app talk to it (the app cannot call `PutBucketCors` until CORS already allows it). This command does those steps from a terminal, runs the same list → write → read → delete probe the app runs, and prints a link that connects the app on this device.

## Usage

```sh
npx @txnlab/zs-sync-setup
```

It asks for the provider, the keys, and a bucket name, then reports each step with a ✓ or ✗ and, on failure, what to change. Every step is safe to repeat, so the answer to any failure is: fix that, then re-run the same command.

Every prompt has a flag, for a one-line run once you know the values:

```sh
ZS_ACCESS_KEY_ID=… ZS_SECRET_ACCESS_KEY=… \
  npx @txnlab/zs-sync-setup --provider filebase --bucket zs-abc123 --json
```

`--help` lists them all. Notes:

- **Keys.** Prefer the `ZS_SECRET_ACCESS_KEY` environment variable or the masked prompt. `--secret-access-key` works but ends up in your shell history.
- **`--json`** runs without prompts and prints the config, every step, the connection string and the link. The output includes the secret key, so do not pipe it into a log.
- **`--prefix`** is empty by default, matching the app. A prefix set here must match the one the app uses, or the two would sync into separate trees in the same bucket.
- **`--origin`** narrows the CORS rule to one origin (repeatable). The default allows any origin, which is not a weakening: what authorises a request is its signature, and no cookie is involved.
- **`--app-url`** defaults to `https://zerosignal.ai`. It must be the address where your passkey lives; a link built for another origin sends a device somewhere its passkey does not exist.
- **`--qr`** also prints a QR code of the link, at the low error-correction level a payload this long needs.

Nothing is written to disk, and nothing is sent anywhere except the endpoint you configure.

## What it does

1. **Bucket** — `HeadBucket`, then `CreateBucket` if missing.
2. **Bucket type** (Filebase only) — writes and deletes a test object and checks the response for an IPFS content id. An IPFS bucket is refused: its objects are fetchable by content id from public gateways, and unpinning is not a guaranteed delete.
3. **CORS** — `PutBucketCors` with the rule the app needs (`GET, PUT, DELETE, HEAD`, all headers, `ETag` exposed, one-hour preflight cache), read back with `GetBucketCors` where the provider supports it.
4. **Versioning** — `GetBucketVersioning`; warns if it is on, because a version history quietly keeps every chat you delete. It is never changed.
5. **Probe** — list, write, read back, delete. The failure text is keyed on which step failed: a 403 on the first step means the keys cannot see the bucket, the same 403 on the second means they are read-only.
6. **Output** — `https://zerosignal.ai/sync#c=zsmirror1:…`, which the app's `/sync` route reads out of the URL fragment (never sent to a server), plus the bare `zsmirror1:` string for pasting. That string is a bearer credential for the bucket: treat it like a password.

## Providers

| Provider      | Notes                                                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filebase      | Endpoint `https://s3.filebase.io`, region `auto`. Bucket type is chosen at creation; only S3-type buckets are accepted. Keys under Access Keys in the console.                                                                                                 |
| Cloudflare R2 | Endpoint `https://<account-id>.r2.cloudflarestorage.com`, region `auto`. An Object Read & Write token cannot create buckets or edit CORS; use an Admin Read & Write token for this run, or do those two steps in the dashboard.                                |
| Amazon S3     | Region and endpoint must both name the bucket's region. The IAM user needs `s3:ListBucket`, `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, plus `s3:CreateBucket` and `s3:PutBucketCORS` for this run.                                                     |
| Garage        | Region must equal `s3_region` in `garage.toml` (samples use `garage`); a wrong region fails as `AuthorizationHeaderMalformed`, which is not a credential problem. The key needs `--create-bucket` to create, or create the bucket with `garage bucket create`. |
| SeaweedFS     | Region `us-east-1` unless configured otherwise. Give the identity Read, Write, List actions on the bucket.                                                                                                                                                     |
| Other         | Any S3-compatible store that can list a bucket and get, put and delete objects. Path-style addressing is the default; turn it off only if the certificate covers `<bucket>.<host>`.                                                                            |

A plain `http://` endpoint, or one on a private address, passes every step here and is then refused by the browser. The tool warns before the steps run.

## Privacy

The bucket sees ciphertext plus shape: file counts, sizes, device ids and write timing. Never content, titles or keys.

## Development

```sh
pnpm install
pnpm test        # vitest, against an in-memory fake bucket
pnpm typecheck && pnpm lint
pnpm build       # tsup → dist/
pnpm dev -- --help
```

The SigV4 signer and the `zsmirror1:` codec are copies of the ZeroSignal client's, pinned by shared fixtures under `test/vectors/`.

## License

Apache-2.0
