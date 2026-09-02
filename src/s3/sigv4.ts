// AWS Signature Version 4, the subset S3 needs.
//
// A signing bug surfaces only as an opaque 403, so every piece is pure and
// separately testable, and the golden vectors in `test/vectors` pin the
// canonical request's hash as well as the final signature — a mismatch then
// localises itself to one side of the HMAC chain.

import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'

export const ALGORITHM = 'AWS4-HMAC-SHA256'

/** SHA-256 of the empty string, which every bodyless request signs. */
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export interface SigV4Credentials {
  accessKeyId: string
  secretAccessKey: string
  /** Temporary credentials only; adds `x-amz-security-token` to the signature. */
  sessionToken?: string
}

export interface SignableRequest {
  method: string
  /** Path with each segment already percent-encoded, `/` intact. Use `canonicalPath`. */
  path: string
  /** Query parameters, unencoded. Order is irrelevant; signing sorts them. */
  query?: readonly (readonly [string, string])[]
  /** Headers to sign, unencoded. `host` and `x-amz-*` are added by the signer. */
  headers?: Readonly<Record<string, string>>
  /** Hex SHA-256 of the body. `EMPTY_PAYLOAD_SHA256` for GET/DELETE. */
  payloadSha256: string
}

export interface SigV4Params {
  request: SignableRequest
  credentials: SigV4Credentials
  region: string
  service: string
  /** The request's host, which is signed but cannot be sent — see `signRequest`. */
  host: string
  now: Date
}

export interface SignedRequest {
  /** Headers to put on the `fetch`, INCLUDING `authorization`. Excludes `host`. */
  headers: Record<string, string>
  /** Exposed for the golden vectors; not needed to send the request. */
  canonicalRequest: string
  stringToSign: string
  signature: string
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const encoder = new TextEncoder()

export function sha256Hex(data: Uint8Array | string): string {
  return toHex(sha256(typeof data === 'string' ? encoder.encode(data) : data))
}

/**
 * Percent-encode per RFC 3986, which is NOT what `encodeURIComponent` does:
 * it leaves `!'()*` alone, AWS expects them encoded, and the only symptom of
 * the disagreement is a 403.
 */
export function uriEncode(value: string, encodeSlash: boolean): string {
  let out = ''
  for (const char of encoder.encode(value)) {
    const c = String.fromCharCode(char)
    if (
      (char >= 0x41 && char <= 0x5a) || // A-Z
      (char >= 0x61 && char <= 0x7a) || // a-z
      (char >= 0x30 && char <= 0x39) || // 0-9
      c === '-' ||
      c === '_' ||
      c === '.' ||
      c === '~'
    ) {
      out += c
    } else if (c === '/' && !encodeSlash) {
      out += c
    } else {
      out += `%${char.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/**
 * Each segment is encoded individually with `/` preserved as the separator —
 * encoding the separators would address a single object whose name contains
 * slashes rather than the intended path.
 */
export function canonicalPath(segments: readonly string[]): string {
  if (segments.length === 0) return '/'
  return `/${segments.map((s) => uriEncode(s, true)).join('/')}`
}

/**
 * Sorted by ENCODED name, then encoded value — AWS compares the encoded forms,
 * and sorting the raw strings disagrees wherever encoding changes the order.
 */
export function canonicalQueryString(
  query: readonly (readonly [string, string])[] = [],
): string {
  return query
    .map(([k, v]) => [uriEncode(k, true), uriEncode(v, true)] as const)
    .sort((a, b) =>
      a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

function canonicalHeaders(headers: Record<string, string>): {
  canonical: string
  signed: string
} {
  const normalised = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return {
    canonical: normalised.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: normalised.map(([k]) => k).join(';'),
  }
}

/** `YYYYMMDDTHHMMSSZ` and its `YYYYMMDD` prefix, both in UTC. */
export function amzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

/** Each HMAC narrows the key's scope to one date, region and service. */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Uint8Array {
  const kDate = hmac(
    sha256,
    encoder.encode(`AWS4${secretAccessKey}`),
    encoder.encode(dateStamp),
  )
  const kRegion = hmac(sha256, kDate, encoder.encode(region))
  const kService = hmac(sha256, kRegion, encoder.encode(service))
  return hmac(sha256, kService, encoder.encode('aws4_request'))
}

export function signRequest(params: SigV4Params): SignedRequest {
  const { request, credentials, region, service, host, now } = params
  const { amzDate: stamp, dateStamp } = amzDate(now)

  // `host` is signed but NOT returned: `fetch` refuses to set it and supplies
  // its own, byte-identical for the URL about to be requested.
  const toSign: Record<string, string> = {
    ...request.headers,
    host,
    'x-amz-content-sha256': request.payloadSha256,
    'x-amz-date': stamp,
  }
  if (credentials.sessionToken)
    toSign['x-amz-security-token'] = credentials.sessionToken

  const { canonical, signed } = canonicalHeaders(toSign)
  const canonicalRequest = [
    request.method,
    request.path,
    canonicalQueryString(request.query),
    canonical,
    signed,
    request.payloadSha256,
  ].join('\n')

  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    ALGORITHM,
    stamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const signature = toHex(
    hmac(
      sha256,
      signingKey(credentials.secretAccessKey, dateStamp, region, service),
      encoder.encode(stringToSign),
    ),
  )

  const headers: Record<string, string> = { ...toSign }
  delete headers.host
  headers.authorization =
    `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signed}, Signature=${signature}`

  return { headers, canonicalRequest, stringToSign, signature }
}
