// Sign, fetch, parse: the S3 surface the mirror needs, plus the bucket-level
// operations first-time setup needs and a browser cannot perform.

import { base64 } from '@scure/base'
import { md5 } from '@noble/hashes/legacy.js'

import { MirrorIOError, type MirrorErrorKind } from './errors.ts'
import {
  canonicalPath,
  canonicalQueryString,
  EMPTY_PAYLOAD_SHA256,
  sha256Hex,
  signRequest,
  type SigV4Credentials,
} from './sigv4.ts'
import { assertWellFormed, blocksOf, textOf } from './xml.ts'

export interface S3MirrorConfig {
  /** Base URL, host only. Filebase documents `https://s3.filebase.io`. */
  endpoint: string
  /** `auto` for Filebase and R2; `us-east-1` for AWS; whatever a self-hosted server signs against. */
  region: string
  bucket: string
  /** Lets one bucket host several profiles. No leading or trailing slash. */
  prefix?: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /**
   * Path-style (`endpoint/bucket/key`) rather than virtual-host style
   * (`bucket.endpoint/key`). Default true: virtual-host style needs a
   * wildcard TLS certificate and per-bucket DNS, which a self-hosted server
   * and several compatible providers do not have.
   */
  forcePathStyle?: boolean
}

export interface S3Object {
  key: string
  size: number
  /** Quotes stripped. Empty when the host omits it. */
  etag: string
  lastModified: string
}

export interface S3Listing {
  objects: S3Object[]
  /** Directory-like prefixes, when the request passed a delimiter. */
  commonPrefixes: string[]
  /** Present when the result was truncated. */
  continuationToken?: string
}

/**
 * Map an S3 failure onto the mirror's vocabulary.
 *
 * `skew` is not `denied`: SigV4 refuses a timestamp more than 15 minutes out
 * with a 403, and folding it in would tell the user their keys are wrong when
 * their clock is. 429 / 503 are `locked`, the mirror's "try later" kind.
 */
export function s3ErrorKind(status: number, code: string): MirrorErrorKind {
  if (code === 'RequestTimeTooSkewed') return 'skew'
  if (status === 404 || code === 'NoSuchKey' || code === 'NoSuchBucket')
    return 'not-found'
  if (status === 403 || status === 401) return 'denied'
  if (status === 429 || status === 503 || code === 'SlowDown') return 'locked'
  if (status === 507) return 'quota'
  if (status >= 500) return 'transient'
  return 'other'
}

/** Pull `<Code>` out of an S3 error document. Empty when the body is not one. */
export function parseErrorCode(xml: string): string {
  const match = /<Code>([^<]*)<\/Code>/.exec(xml)
  return match ? match[1] : ''
}

export function parseListing(xml: string): S3Listing {
  assertWellFormed(xml, 'ListBucketResult')
  const objects: S3Object[] = blocksOf(xml, 'Contents').map((block) => ({
    key: textOf(block, 'Key'),
    size: Number(textOf(block, 'Size') || 0),
    // Quotes are transport syntax; a multipart `-N` suffix is part of the value.
    etag: textOf(block, 'ETag').replace(/^"|"$/g, ''),
    lastModified: textOf(block, 'LastModified'),
  }))
  const commonPrefixes = blocksOf(xml, 'CommonPrefixes').map((block) =>
    textOf(block, 'Prefix'),
  )
  const truncated = textOf(xml, 'IsTruncated') === 'true'
  const next = textOf(xml, 'NextContinuationToken')
  return {
    objects,
    commonPrefixes,
    continuationToken: truncated && next ? next : undefined,
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

interface SendOptions {
  method: string
  /** Key segments relative to the bucket, unencoded. */
  segments: readonly string[]
  query?: readonly (readonly [string, string])[]
  body?: Uint8Array
  headers?: Record<string, string>
  /** Statuses to return rather than throw — e.g. 404 on a read. */
  tolerate?: readonly number[]
}

/** Regions with no `LocationConstraint`: AWS's default, and the vendors with none. */
const NO_LOCATION_CONSTRAINT = new Set(['', 'us-east-1', 'auto'])

export class S3Client {
  private readonly base: URL
  private readonly credentials: SigV4Credentials

  constructor(
    readonly config: S3MirrorConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.base = new URL(config.endpoint)
    this.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
    }
  }

  /** `bucket/prefix`, for status copy. */
  get label(): string {
    return this.config.prefix
      ? `${this.config.bucket}/${this.config.prefix}`
      : this.config.bucket
  }

  /**
   * Prepend the configured prefix, keeping the result SPLIT: `canonicalPath`
   * encodes each segment, so a pre-joined string would percent-encode the
   * slashes and address one object whose name contains them.
   */
  keySegments(segments: readonly string[]): string[] {
    const prefixParts = this.config.prefix
      ? this.config.prefix.split('/').filter(Boolean)
      : []
    return [...prefixParts, ...segments]
  }

  /** The slash-joined form, for listing prefixes and status copy. */
  key(segments: readonly string[]): string {
    return this.keySegments(segments).join('/')
  }

  private target(segments: readonly string[]): {
    url: URL
    pathSegments: string[]
  } {
    const pathStyle = this.config.forcePathStyle !== false
    const url = new URL(this.base.toString())
    const keyParts = segments.filter((s) => s.length > 0)
    if (pathStyle) {
      return { url, pathSegments: [this.config.bucket, ...keyParts] }
    }
    url.host = `${this.config.bucket}.${this.base.host}`
    return { url, pathSegments: keyParts }
  }

  async send(options: SendOptions): Promise<Response> {
    const { url, pathSegments } = this.target(options.segments)
    const path = canonicalPath(pathSegments)
    const body = options.body
    const signed = signRequest({
      request: {
        method: options.method,
        path,
        query: options.query,
        headers: options.headers,
        payloadSha256: body ? sha256Hex(body) : EMPTY_PAYLOAD_SHA256,
      },
      credentials: this.credentials,
      region: this.config.region,
      service: 's3',
      host: url.host,
      now: this.now(),
    })

    // The SAME function that built the signed form, not `encodeURIComponent`:
    // the two must agree byte for byte or the server answers 403 with nothing
    // in the body, and they do not agree for `!'()*`.
    const query = canonicalQueryString(options.query)
    const href = `${url.origin}${path}${query ? `?${query}` : ''}`

    let response: Response
    try {
      response = await this.fetchImpl(href, {
        method: options.method,
        headers: signed.headers,
        body: body as RequestInit['body'],
        // A 301 from S3 means "wrong region"; following it would re-sign
        // nothing and lose the status that says so.
        redirect: 'manual',
      })
    } catch (err) {
      throw new MirrorIOError(
        'blocked',
        err instanceof Error ? err.name : 'TypeError',
        { cause: err },
      )
    }

    if (response.ok || options.tolerate?.includes(response.status))
      return response

    let code = ''
    try {
      code = parseErrorCode(await response.text())
    } catch {
      code = ''
    }
    throw new MirrorIOError(
      s3ErrorKind(response.status, code),
      code || `HTTP ${response.status}`,
      { status: response.status },
    )
  }

  /** One page of a listing. The caller paginates. */
  async listObjects(options: {
    prefix: string
    delimiter?: string
    continuationToken?: string
    maxKeys?: number
  }): Promise<S3Listing> {
    const query: [string, string][] = [
      ['list-type', '2'],
      ['prefix', options.prefix],
    ]
    if (options.delimiter) query.push(['delimiter', options.delimiter])
    if (options.continuationToken)
      query.push(['continuation-token', options.continuationToken])
    if (options.maxKeys !== undefined)
      query.push(['max-keys', String(options.maxKeys)])

    const response = await this.send({ method: 'GET', segments: [], query })
    return parseListing(await response.text())
  }

  /** Null when absent — the read paths fold "missing" into "nothing here". */
  async getObject(segments: readonly string[]): Promise<Uint8Array | null> {
    const response = await this.send({
      method: 'GET',
      segments: this.keySegments(segments),
      tolerate: [404],
    })
    if (response.status === 404) return null
    return new Uint8Array(await response.arrayBuffer())
  }

  async putObject(
    segments: readonly string[],
    body: Uint8Array,
  ): Promise<void> {
    await this.putObjectWithHeaders(segments, body)
  }

  /** As `putObject`, returning the response headers (Filebase reports an IPFS CID there). */
  async putObjectWithHeaders(
    segments: readonly string[],
    body: Uint8Array,
  ): Promise<Headers> {
    const response = await this.send({
      method: 'PUT',
      segments: this.keySegments(segments),
      body,
      headers: { 'content-type': 'application/octet-stream' },
    })
    return response.headers
  }

  /** Response headers, or null when the object is absent. */
  async headObject(segments: readonly string[]): Promise<Headers | null> {
    const response = await this.send({
      method: 'HEAD',
      segments: this.keySegments(segments),
      tolerate: [404],
    })
    return response.status === 404 ? null : response.headers
  }

  /** Missing is success — the goal is absence, not the act. */
  async deleteObject(segments: readonly string[]): Promise<void> {
    await this.send({
      method: 'DELETE',
      segments: this.keySegments(segments),
      tolerate: [404],
    })
  }

  // ---- bucket-level operations ------------------------------------------

  /**
   * The raw status: 200 exists, 404 missing, 403 "not telling", 301/307 wrong
   * region, 400 usually also wrong region. A HEAD carries no error body, so
   * the status is all there is.
   */
  async headBucket(): Promise<number> {
    const response = await this.send({
      method: 'HEAD',
      segments: [],
      tolerate: [301, 307, 400, 403, 404],
    })
    return response.status
  }

  async createBucket(): Promise<void> {
    const region = this.config.region
    const body = NO_LOCATION_CONSTRAINT.has(region)
      ? undefined
      : new TextEncoder().encode(
          `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            `<LocationConstraint>${region}</LocationConstraint>` +
            `</CreateBucketConfiguration>`,
        )
    await this.send({
      method: 'PUT',
      segments: [],
      body,
      headers: body ? { 'content-type': 'application/xml' } : undefined,
    })
  }

  /** Only ever used to undo a bucket this tool just created. */
  async deleteBucket(): Promise<void> {
    await this.send({ method: 'DELETE', segments: [], tolerate: [404] })
  }

  /** AWS requires `Content-MD5` on this call; the others ignore it. */
  async putBucketCors(xml: string): Promise<void> {
    const body = new TextEncoder().encode(xml)
    await this.send({
      method: 'PUT',
      segments: [],
      query: [['cors', '']],
      body,
      headers: {
        'content-type': 'application/xml',
        'content-md5': base64.encode(md5(body)),
      },
    })
  }

  /** The configuration document, or null when the bucket has none. */
  async getBucketCors(): Promise<string | null> {
    const response = await this.send({
      method: 'GET',
      segments: [],
      query: [['cors', '']],
      tolerate: [404],
    })
    if (response.status === 404) return null
    return response.text()
  }

  async getBucketVersioning(): Promise<string> {
    const response = await this.send({
      method: 'GET',
      segments: [],
      query: [['versioning', '']],
    })
    return response.text()
  }
}
