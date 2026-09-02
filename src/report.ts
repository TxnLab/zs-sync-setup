// What went wrong, in terms of the thing the user can change. Ported from the
// client's probe report and re-worded for a terminal: from Node a request
// that gets no answer is DNS, TLS or the network, never CORS.

import { MirrorIOError } from './s3/errors.ts'
import type { S3ProviderId } from './s3/providers.ts'
import type { S3ConnectionTest, S3ProbeStep } from './s3/setup.ts'
import { notesFor } from './provider-notes.ts'

export const RERUN = 'Fix that, then re-run the same command.'

export const PROBE_LABELS: Record<S3ProbeStep, string> = {
  list: 'List the bucket',
  write: 'Write a test object',
  read: 'Read it back',
  delete: 'Delete it',
}

export const PROBE_ORDER: readonly S3ProbeStep[] = [
  'list',
  'write',
  'read',
  'delete',
]

export interface HttpFacts {
  status?: number
  code?: string
}

export function httpFacts(err: unknown): HttpFacts | undefined {
  const e = err as Partial<MirrorIOError> | undefined
  if (!e || typeof e !== 'object' || e.name !== 'MirrorIOError')
    return undefined
  // A request that never got an answer has no HTTP facts to report.
  if (e.kind === 'blocked') return undefined
  const code =
    e.sourceName && !/^HTTP \d+$/.test(e.sourceName) ? e.sourceName : undefined
  return e.status === undefined && code === undefined
    ? undefined
    : { status: e.status, code }
}

/** ` (HTTP 403 AccessDenied)`, or as much of it as is known. */
export function httpLabel(http?: HttpFacts): string {
  if (!http) return ''
  const parts = [
    http.status !== undefined ? `HTTP ${http.status}` : '',
    http.code ?? '',
  ].filter(Boolean)
  return parts.length ? ` (${parts.join(' ')})` : ''
}

/**
 * Error codes whose meaning is the same at every step, and whose obvious
 * reading is wrong.
 */
export function signingProblem(
  code: string | undefined,
  providerId: S3ProviderId,
): string | null {
  switch (code) {
    case 'AuthorizationHeaderMalformed':
      return `The signature names a region the server does not expect, which is not a credential problem. ${notesFor(providerId).regionHint}`
    case 'SignatureDoesNotMatch':
      return 'The secret key does not match, or a stray character came along when it was pasted. Re-copy it from the console.'
    case 'InvalidAccessKeyId':
      return 'The access key ID is not one this endpoint knows. Re-copy it, and check the endpoint belongs to the same account.'
    case 'RequestTimeTooSkewed':
      return 'This machine’s clock is more than 15 minutes off. Signed requests are rejected for that alone; correct the clock. The keys are probably fine.'
    case 'PermanentRedirect':
    case 'IllegalLocationConstraintException':
      return 'The bucket lives in a different region from the one the endpoint and region fields name. Use the bucket’s own region in both.'
    default:
      return null
  }
}

export function unreachable(endpoint: string, err: unknown): string {
  const name =
    err instanceof MirrorIOError
      ? err.sourceName
      : err instanceof Error
        ? err.name
        : 'Error'
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? ` — ${err.cause.message}`
      : ''
  return `Could not reach ${endpoint} (${name}${cause}). From a terminal that is the address, DNS, TLS or the network, not CORS. Nothing reached the bucket.`
}

/** The sentence for a failed probe. Keyed on step and kind because a 403 means different things at different steps. */
export function probeFailure(
  test: S3ConnectionTest,
  providerId: S3ProviderId,
  endpoint: string,
): string {
  if (test.ok) return 'List, write, read back, delete: all four passed.'
  const step = test.failedStep ?? 'list'
  const known = signingProblem(test.sourceName, providerId)
  const label = httpLabel({ status: test.status, code: test.sourceName })

  switch (test.kind) {
    case 'blocked':
      return unreachable(endpoint, {
        name: test.sourceName ?? 'TypeError',
      } as Error)
    case 'skew':
      return signingProblem('RequestTimeTooSkewed', providerId)!
    case 'denied':
      if (known) return `${known}${label}`
      if (step === 'list')
        return `The bucket rejected the credentials, or they are not allowed to list its contents${label}. Listing is not optional: it is how a device finds what the others wrote.`
      if (step === 'write')
        return `The credentials can read this bucket but not write to it${label}. Give the key object write permission, or use a key that has it.`
      if (step === 'delete')
        return `The credentials can read and write but not delete${label}. Deleting a chat has to actually remove it, so this key is not enough.`
      return `The bucket rejected the credentials${label}.`
    case 'not-found':
      return step === 'list'
        ? `No bucket by that name at this endpoint${label}. Check the bucket name, and that the endpoint belongs to the account that owns it.`
        : `The test object was gone by the time it was read back${label}.`
    case 'locked':
      return `The service asked us to slow down${label}. Wait a moment and try again.`
    case 'quota':
      return 'The bucket is full.'
    default:
      if (known) return `${known}${label}`
      if (test.sourceName === 'ContentMismatch')
        return 'The bucket returned different bytes than were written to it. Whatever is on the other end is not storing objects verbatim, so it is not safe to sync to.'
      return `Failed while trying to ${PROBE_LABELS[step].toLowerCase()}${label}.`
  }
}
