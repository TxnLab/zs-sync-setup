// One string that carries a whole bucket configuration, so a second device
// does not retype six fields on a phone keyboard.
//
// **It is a bearer credential in one line.** Anyone holding it can read and
// write the bucket. The deep-link form rides a URL *fragment*, which browsers
// never send to a server.
//
// `base64urlnopad` because the string travels inside a URL fragment, where
// `+`, `/` and `=` all need escaping; encoding around that at each call site
// is how the two halves drift.

import { base64urlnopad } from '@scure/base'

import type { S3MirrorConfig } from './client.ts'
import { S3_PROVIDERS, type S3ProviderId } from './providers.ts'

const VERSION = 1
const PREFIX = `zsmirror${VERSION}:`

/** Matches any version, so a newer one is recognised rather than rejected as noise. */
const ANY_VERSION = /^zsmirror(\d+):/

/** Field names are the config's own, so a blob is self-describing when pasted into a decoder. */
interface ConnectionPayload {
  endpoint: string
  region: string
  bucket: string
  prefix?: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
  /**
   * Carried rather than inferred from the endpoint: a self-hosted server is
   * on an arbitrary hostname, so inference would answer `other` for exactly
   * the providers whose region defaults differ.
   */
  providerId?: S3ProviderId
}

export type ConnectionStringFailure =
  /** Not this format at all — most likely the user pasted something else. */
  | 'not-a-connection-string'
  /** This format, from a version that postdates this build. */
  | 'newer-version'
  /** Right prefix, but the body is not base64url of JSON. */
  | 'malformed'
  /** Decoded, but a field the mirror cannot work without is missing. */
  | 'incomplete'

export type ConnectionStringResult =
  | { ok: true; config: S3MirrorConfig; providerId: S3ProviderId }
  | { ok: false; reason: ConnectionStringFailure }

function isProviderId(value: unknown): value is S3ProviderId {
  return typeof value === 'string' && S3_PROVIDERS.some((p) => p.id === value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * `sessionToken` is deliberately dropped: it is short-lived, and a string
 * whose purpose is to be scanned later would hand the second device a
 * configuration that stops working without explanation.
 */
export function encodeConnectionString(
  config: S3MirrorConfig,
  providerId: S3ProviderId,
): string {
  const payload: ConnectionPayload = {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    providerId,
  }
  if (config.prefix) payload.prefix = config.prefix
  // Only when it differs from the default the reader applies.
  if (config.forcePathStyle === false) payload.forcePathStyle = false

  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  return `${PREFIX}${base64urlnopad.encode(bytes)}`
}

export function decodeConnectionString(text: string): ConnectionStringResult {
  const trimmed = text.trim()

  const version = ANY_VERSION.exec(trimmed)
  if (!version) return { ok: false, reason: 'not-a-connection-string' }
  if (Number(version[1]) !== VERSION)
    return { ok: false, reason: 'newer-version' }

  let payload: unknown
  try {
    payload = JSON.parse(
      new TextDecoder().decode(
        base64urlnopad.decode(trimmed.slice(PREFIX.length)),
      ),
    )
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return { ok: false, reason: 'malformed' }
  }

  const p = payload as Record<string, unknown>
  if (
    !nonEmptyString(p.endpoint) ||
    !nonEmptyString(p.region) ||
    !nonEmptyString(p.bucket) ||
    !nonEmptyString(p.accessKeyId) ||
    !nonEmptyString(p.secretAccessKey)
  ) {
    return { ok: false, reason: 'incomplete' }
  }

  // Rebuilt field by field, never spread: the blob is untrusted input and a
  // spread would carry a `sessionToken` this format does not transport.
  const config: S3MirrorConfig = {
    endpoint: p.endpoint.trim(),
    region: p.region.trim(),
    bucket: p.bucket.trim(),
    accessKeyId: p.accessKeyId.trim(),
    secretAccessKey: p.secretAccessKey.trim(),
    // Re-segmented exactly as `normalizeS3Config` does: `/sync` hands this
    // straight to the engine, and a prefix of `' chats'` is a DIFFERENT key
    // namespace — every probe step passes and the device syncs into an empty
    // parallel tree.
    prefix:
      typeof p.prefix === 'string'
        ? p.prefix.trim().split('/').filter(Boolean).join('/')
        : '',
    // Absent means the default, which is path-style; only an explicit `false` turns it off.
    forcePathStyle: p.forcePathStyle !== false,
  }

  return {
    ok: true,
    config,
    providerId: isProviderId(p.providerId) ? p.providerId : 'other',
  }
}

/**
 * The link a QR encodes: the app's own address with the string in the
 * fragment. The receiving `/sync` route reads `c` out of the fragment and
 * strips it from the address bar before doing anything else.
 */
export function connectionDeepLink(
  origin: string,
  connectionString: string,
): string {
  return `${origin}/sync#c=${encodeURIComponent(connectionString)}`
}

/** The other half of `connectionDeepLink`, for whatever is holding a fragment. */
export function connectionStringFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const value = params.get('c')
  return value && value.length > 0 ? value : null
}
