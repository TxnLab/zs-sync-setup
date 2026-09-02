// Flags and environment → a partial form. Anything missing is prompted for
// interactively, or is a usage error under `--json`.

import { parseArgs } from 'node:util'

import { S3_PROVIDERS, type S3ProviderId } from './s3/providers.ts'
import { applyProvider, emptyS3Form, type S3FormValues } from './s3/setup.ts'

export const DEFAULT_APP_URL = 'https://zerosignal.ai'

export interface CliOptions {
  help: boolean
  version: boolean
  json: boolean
  qr: boolean
  yes: boolean
  appUrl: string
  origins: string[]
  providerId?: S3ProviderId
  /** Only the fields that were given. */
  given: Partial<S3FormValues>
}

export interface ParsedArgs {
  options: CliOptions
  errors: string[]
}

export const USAGE = `Usage: npx @txnlab/zs-sync-setup [options]

Sets up an S3-compatible bucket for ZeroSignal synced storage from a terminal:
creates the bucket if needed, applies the CORS rule the app needs, checks
versioning, runs the same connection probe the app runs, and prints the link
that connects this app.

Every prompt has a flag, so the whole thing can run in one line.

  --provider <id>           filebase | r2 | aws | garage | seaweedfs | other
  --endpoint <url>          Host only, e.g. https://s3.filebase.io
  --region <name>           Signing region (auto for Filebase and R2)
  --access-key-id <id>      Or env ZS_ACCESS_KEY_ID
  --secret-access-key <key> Or env ZS_SECRET_ACCESS_KEY. Prefer the env var
                            or the masked prompt: a flag ends up in shell history.
  --bucket <name>           Default: a random zs-… name is suggested
  --prefix <path>           Key prefix inside the bucket. Default: none
  --origin <url>            CORS AllowedOrigins; repeatable. Default: *
  --app-url <url>           The app origin the link points at.
                            Default ${DEFAULT_APP_URL}. Must be the address
                            where your passkey lives.
  --path-style              Force path-style addressing (default for all but AWS)
  --no-path-style           Use virtual-host addressing (default for AWS)
  --qr                      Also print a QR code of the link
  --json                    No prompts; print the config, every step, the
                            connection string and the link as JSON.
                            The output includes the secret key.
  --yes                     Skip confirmations
  -h, --help
  -v, --version

Exit codes: 0 everything passed · 1 a step failed · 2 usage error.

Nothing is written to disk, and nothing is sent anywhere except the endpoint.
`

const PROVIDER_IDS = S3_PROVIDERS.map((p) => p.id)

function isProviderId(value: string): value is S3ProviderId {
  return (PROVIDER_IDS as string[]).includes(value)
}

export function parseCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
): ParsedArgs {
  const errors: string[] = []
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse([...argv])
  } catch (err) {
    return {
      options: { ...emptyOptions(), help: false },
      errors: [err instanceof Error ? err.message : String(err)],
    }
  }
  const v = parsed.values

  const options = emptyOptions()
  options.help = Boolean(v.help)
  options.version = Boolean(v.version)
  options.json = Boolean(v.json)
  options.qr = Boolean(v.qr)
  options.yes = Boolean(v.yes)
  if (v['app-url']) {
    try {
      options.appUrl = new URL(v['app-url']).origin
    } catch {
      errors.push(`--app-url is not a URL: ${v['app-url']}`)
    }
  }
  if (v.origin && v.origin.length > 0) options.origins = [...v.origin]

  if (v.provider !== undefined) {
    if (isProviderId(v.provider)) options.providerId = v.provider
    else errors.push(`--provider must be one of ${PROVIDER_IDS.join(', ')}`)
  }

  const given: Partial<S3FormValues> = {}
  if (v.endpoint !== undefined) given.endpoint = v.endpoint
  if (v.region !== undefined) given.region = v.region
  const accessKeyId = v['access-key-id'] ?? env.ZS_ACCESS_KEY_ID
  if (accessKeyId !== undefined) given.accessKeyId = accessKeyId
  const secret = v['secret-access-key'] ?? env.ZS_SECRET_ACCESS_KEY
  if (secret !== undefined) given.secretAccessKey = secret
  if (v.bucket !== undefined) given.bucket = v.bucket
  if (v.prefix !== undefined) given.prefix = v.prefix
  if (v['path-style'] && v['no-path-style'])
    errors.push('--path-style and --no-path-style contradict each other')
  else if (v['path-style']) given.forcePathStyle = true
  else if (v['no-path-style']) given.forcePathStyle = false
  options.given = given

  return { options, errors }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      provider: { type: 'string' },
      endpoint: { type: 'string' },
      region: { type: 'string' },
      'access-key-id': { type: 'string' },
      'secret-access-key': { type: 'string' },
      bucket: { type: 'string' },
      prefix: { type: 'string' },
      origin: { type: 'string', multiple: true },
      'app-url': { type: 'string' },
      'path-style': { type: 'boolean' },
      'no-path-style': { type: 'boolean' },
      qr: { type: 'boolean' },
      json: { type: 'boolean' },
      yes: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
}

function emptyOptions(): CliOptions {
  return {
    help: false,
    version: false,
    json: false,
    qr: false,
    yes: false,
    appUrl: DEFAULT_APP_URL,
    origins: ['*'],
    given: {},
  }
}

/** The preset's defaults, overlaid with whatever was given. */
export function formFromOptions(
  options: CliOptions,
  providerId: S3ProviderId,
): S3FormValues {
  const base = applyProvider(emptyS3Form(providerId), providerId)
  return { ...base, ...options.given, providerId }
}

/** What `--json` cannot proceed without. */
export function missingForNonInteractive(options: CliOptions): string[] {
  const missing: string[] = []
  if (!options.providerId) missing.push('--provider')
  const form = options.providerId
    ? formFromOptions(options, options.providerId)
    : undefined
  if (form && !form.endpoint.trim()) missing.push('--endpoint')
  if (form && !form.region.trim()) missing.push('--region')
  if (!options.given.accessKeyId)
    missing.push('--access-key-id or ZS_ACCESS_KEY_ID')
  if (!options.given.secretAccessKey)
    missing.push('--secret-access-key or ZS_SECRET_ACCESS_KEY')
  if (!options.given.bucket) missing.push('--bucket')
  return missing
}
