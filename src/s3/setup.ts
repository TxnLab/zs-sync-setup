// Turning what a user typed into a config, and finding out whether it works.
//
// The probe runs the four operations the mirror needs, in order, and reports
// WHICH one failed. Listing is first and not optional: it is a GET on the
// bucket itself, the one operation a per-object permission or CORS model
// cannot express — a store that can read, write and delete but not enumerate
// looks healthy to any other probe and then pulls nothing, forever.

import { MirrorIOError, type MirrorErrorKind } from './errors.ts'
import { MIRROR_ROOT } from './paths.ts'
import { S3Client, type FetchLike, type S3MirrorConfig } from './client.ts'
import { providerById, type S3ProviderId } from './providers.ts'

/** What the form holds: strings, before any of it is known to be valid. */
export interface S3FormValues {
  providerId: S3ProviderId
  endpoint: string
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

export function emptyS3Form(
  providerId: S3ProviderId = 'filebase',
): S3FormValues {
  const provider = providerById(providerId)
  return {
    providerId,
    endpoint: provider.endpoint ?? '',
    region: provider.region,
    bucket: '',
    prefix: '',
    accessKeyId: '',
    secretAccessKey: '',
    forcePathStyle: provider.forcePathStyle,
  }
}

/** Re-seed the vendor-derived fields, leaving what the user typed alone. */
export function applyProvider(
  values: S3FormValues,
  providerId: S3ProviderId,
): S3FormValues {
  const provider = providerById(providerId)
  return {
    ...values,
    providerId,
    endpoint: provider.endpoint ?? '',
    region: provider.region,
    forcePathStyle: provider.forcePathStyle,
  }
}

export type S3Field =
  | 'endpoint'
  | 'region'
  | 'bucket'
  | 'prefix'
  | 'accessKeyId'
  | 'secretAccessKey'

/**
 * S3's bucket naming rule, as the DNS-safe subset every implementation
 * agrees on. The server's answer to a bad name is a 400 with an opaque code.
 */
export const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

export function validateS3Form(
  values: S3FormValues,
): Partial<Record<S3Field, string>> {
  const errors: Partial<Record<S3Field, string>> = {}

  const endpoint = values.endpoint.trim()
  if (!endpoint) {
    errors.endpoint = 'Required.'
  } else {
    let url: URL | null = null
    try {
      url = new URL(withScheme(endpoint))
    } catch {
      url = null
    }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      errors.endpoint = 'Not a web address.'
    } else if (url.pathname !== '' && url.pathname !== '/') {
      // The signer builds the path from bucket and key alone, so a pasted
      // path is silently dropped and every request addresses the wrong place.
      errors.endpoint =
        'Just the host — leave the bucket name out of this field.'
    }
  }

  if (!values.region.trim()) errors.region = 'Required.'

  const bucket = values.bucket.trim()
  if (!bucket) {
    errors.bucket = 'Required.'
  } else if (!BUCKET_RE.test(bucket)) {
    errors.bucket =
      'Lowercase letters, numbers, dots and hyphens; 3–63 characters.'
  }

  if (values.prefix.trim().startsWith('/')) errors.prefix = 'No leading slash.'

  if (!values.accessKeyId.trim()) errors.accessKeyId = 'Required.'
  if (!values.secretAccessKey.trim()) errors.secretAccessKey = 'Required.'

  return errors
}

function withScheme(endpoint: string): string {
  return /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`
}

/**
 * Form values → config. Everything is trimmed, the credentials most of all: a
 * key pasted out of a dashboard routinely carries a trailing newline, which is
 * signed verbatim and comes back as a 403 that reads exactly like a wrong key.
 */
export function normalizeS3Config(values: S3FormValues): S3MirrorConfig {
  const endpoint = withScheme(values.endpoint.trim()).replace(/\/+$/, '')
  return {
    endpoint,
    region: values.region.trim(),
    bucket: values.bucket.trim(),
    prefix: values.prefix.split('/').filter(Boolean).join('/'),
    accessKeyId: values.accessKeyId.trim(),
    secretAccessKey: values.secretAccessKey.trim(),
    forcePathStyle: values.forcePathStyle,
  }
}

/** Form values for an already-connected bucket, so it can be edited. */
export function formFromConfig(
  config: S3MirrorConfig,
  providerId: S3ProviderId,
): S3FormValues {
  return {
    providerId,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix ?? '',
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle !== false,
  }
}

export type S3ProbeStep = 'list' | 'write' | 'read' | 'delete'

export interface S3ConnectionTest {
  ok: boolean
  /** The first step that failed. Absent when everything passed. */
  failedStep?: S3ProbeStep
  kind?: MirrorErrorKind
  /** The provider's own error code, when it sent one. Never a message. */
  sourceName?: string
  /** The HTTP status behind the failure, when there was one. */
  status?: number
}

/**
 * Under the mirror root but OUTSIDE `devices/`, the only subtree the pull
 * pass enumerates — so a probe left behind by an interrupted test is inert.
 */
export const PROBE_DIR = '.connection-test'

export function probeSegments(nonce: string): string[] {
  return [MIRROR_ROOT, PROBE_DIR, nonce]
}

export function randomNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

function failure(step: S3ProbeStep, err: unknown): S3ConnectionTest {
  if (err instanceof MirrorIOError) {
    return {
      ok: false,
      failedStep: step,
      kind: err.kind,
      sourceName: err.sourceName,
      status: err.status,
    }
  }
  return {
    ok: false,
    failedStep: step,
    kind: 'other',
    sourceName: err instanceof Error ? err.name : 'Error',
  }
}

/**
 * List, write, read back, delete. The read step compares the bytes: a store
 * that accepts a PUT and returns a different object on GET would otherwise
 * pass, and then corrupt every record it was handed.
 */
export async function testS3Connection(
  config: S3MirrorConfig,
  fetchImpl?: FetchLike,
): Promise<S3ConnectionTest> {
  const client = new S3Client(config, fetchImpl)
  const nonce = randomNonce()
  const segments = probeSegments(nonce)
  const payload = crypto.getRandomValues(new Uint8Array(16))

  try {
    await client.listObjects({ prefix: client.key([]), maxKeys: 1 })
  } catch (err) {
    return failure('list', err)
  }

  try {
    await client.putObject(segments, payload)
  } catch (err) {
    return failure('write', err)
  }

  let readBack: Uint8Array | null
  try {
    readBack = await client.getObject(segments)
  } catch (err) {
    await discardProbe(client, segments)
    return failure('read', err)
  }
  if (!readBack || !sameBytes(readBack, payload)) {
    await discardProbe(client, segments)
    return {
      ok: false,
      failedStep: 'read',
      kind: 'other',
      sourceName: 'ContentMismatch',
    }
  }

  try {
    await client.deleteObject(segments)
  } catch (err) {
    return failure('delete', err)
  }

  return { ok: true }
}

/** Best-effort tidy-up. A probe we cannot delete is not worth a second error. */
async function discardProbe(
  client: S3Client,
  segments: readonly string[],
): Promise<void> {
  try {
    await client.deleteObject(segments)
  } catch {
    // Reporting this would replace the real failure with a consequence of it.
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * The CORS rule a bucket needs before a browser may talk to it.
 *
 * `AllowedOrigins: ["*"]` is not a weakening: authorization is the signed
 * request, no cookie is involved, and an origin restriction protects nothing
 * the signature does not. It is also required in practice — the static build
 * is served from a content-addressed host, so its origin changes with every
 * release. An origin list is accepted for a fixed deployment.
 *
 * `HEAD` is included although nothing sends one yet, so a policy applied once
 * need not be revisited. `ExposeHeaders: ["ETag"]` is for the path that reads
 * an ETag off a `PutObject` response, which would otherwise read `null` and
 * re-upload every record. `MaxAgeSeconds` matters: every signed request
 * carries `Authorization`, so every one is preflighted unless the browser may
 * cache the answer.
 */
export const CORS_ALLOWED_METHODS = ['GET', 'PUT', 'DELETE', 'HEAD'] as const

export function corsPolicyJson(origins: readonly string[] = ['*']): string {
  return `${JSON.stringify(
    [
      {
        AllowedOrigins: [...origins],
        AllowedMethods: [...CORS_ALLOWED_METHODS],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      },
    ],
    null,
    2,
  )}\n`
}
