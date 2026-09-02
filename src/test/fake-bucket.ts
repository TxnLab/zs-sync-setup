// In-memory S3 behind a fake `fetch`, so the real client — signing, key
// encoding, XML parsing, error mapping — is exercised against something that
// answers the way S3 does. Copied from the client and extended with the
// bucket-level operations setup needs.
//
// Not a `.test.ts` file, so vitest does not collect it.

import type { FetchLike } from '../s3/client.ts'

interface StoredObject {
  body: Uint8Array
  etag: string
  lastModified: string
}

export type FakeOp =
  | 'HeadBucket'
  | 'CreateBucket'
  | 'DeleteBucket'
  | 'PutBucketCors'
  | 'GetBucketCors'
  | 'GetBucketVersioning'
  | 'ListObjectsV2'
  | 'GetObject'
  | 'HeadObject'
  | 'PutObject'
  | 'DeleteObject'

export interface FakeBucket {
  fetch: FetchLike
  /** Seed or inspect object bytes directly, bypassing HTTP. */
  put(key: string, body: string | Uint8Array): void
  get(key: string): Uint8Array | undefined
  has(key: string): boolean
  keys(): string[]
  remove(key: string): void
  /** Requests seen, most recent last: `GET /bucket/key?query`. */
  requests(): string[]
  resetRequests(): void
  /** Operations seen, by name. */
  ops(): FakeOp[]
  count(op: FakeOp): number
  /** How many list pages have been served. */
  listCalls(): number
  /** Whether the bucket exists. Default true. */
  exists(): boolean
  setExists(value: boolean): void
  /** The CORS document last PUT, or null. */
  cors(): string | null
  setVersioning(status: '' | 'Enabled' | 'Suspended'): void
  /** Answer object writes with `x-amz-meta-cid`, as a Filebase IPFS bucket does. */
  ipfsMode(on: boolean): void
  // Fault injection, each modelling something a real bucket does.
  /** Reject with a bare TypeError: the network never answered. */
  blockNetwork(): void
  allowNetwork(): void
  /** Answer every request with this status and S3 error code. */
  failWith(status: number, code: string): void
  /** Answer one operation with this status and code. */
  failOp(op: FakeOp, status: number, code: string): void
  /** Answer one operation 501 NotImplemented. */
  notImplemented(op: FakeOp): void
  clearFailure(): void
  /** Serve listings this many keys at a time, forcing continuation tokens. */
  setPageSize(n: number): void
  /** Stop reporting ETags, as a host may. */
  hideEtags(): void
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function response(
  status: number,
  body: string,
  contentType = 'application/xml',
): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  })
}

function errorResponse(status: number, code: string): Response {
  return response(
    status,
    `<?xml version="1.0"?><Error><Code>${code}</Code></Error>`,
  )
}

export function createFakeBucket(bucket = 'test-bucket'): FakeBucket {
  const objects = new Map<string, StoredObject>()
  const seen: string[] = []
  const opsSeen: FakeOp[] = []
  let networkBlocked = false
  let failure: { status: number; code: string } | null = null
  const opFailures = new Map<FakeOp, { status: number; code: string }>()
  let pageSize = 1000
  let etagsHidden = false
  let listCalls = 0
  let clock = 1_700_000_000_000
  let etagSeed = 0
  let exists = true
  let corsDoc: string | null = null
  let versioning: '' | 'Enabled' | 'Suspended' = ''
  let ipfs = false

  function store(key: string, body: Uint8Array): void {
    clock += 1000
    etagSeed++
    objects.set(key, {
      body,
      etag: `etag-${etagSeed}-${body.length}`,
      lastModified: new Date(clock).toISOString(),
    })
  }

  function classify(
    method: string,
    key: string,
    params: URLSearchParams,
  ): FakeOp | null {
    if (key === '') {
      if (params.has('cors'))
        return method === 'PUT'
          ? 'PutBucketCors'
          : method === 'GET'
            ? 'GetBucketCors'
            : null
      if (params.has('versioning'))
        return method === 'GET' ? 'GetBucketVersioning' : null
      if (params.get('list-type') === '2' && method === 'GET')
        return 'ListObjectsV2'
      if (method === 'HEAD') return 'HeadBucket'
      if (method === 'PUT') return 'CreateBucket'
      if (method === 'DELETE') return 'DeleteBucket'
      return null
    }
    if (method === 'GET') return 'GetObject'
    if (method === 'HEAD') return 'HeadObject'
    if (method === 'PUT') return 'PutObject'
    if (method === 'DELETE') return 'DeleteObject'
    return null
  }

  const fetchImpl: FetchLike = async (url, init) => {
    const parsed = new URL(url)
    const method = init.method ?? 'GET'
    seen.push(`${method} ${parsed.pathname}${parsed.search}`)

    if (networkBlocked) {
      throw new TypeError('fetch failed')
    }
    if (failure) return errorResponse(failure.status, failure.code)

    const headers = new Headers(init.headers)
    if (!headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 ')) {
      return errorResponse(403, 'AccessDenied')
    }

    const path = decodeURIComponent(parsed.pathname)
    const prefixPath = `/${bucket}`
    if (path !== prefixPath && !path.startsWith(`${prefixPath}/`)) {
      return errorResponse(404, 'NoSuchBucket')
    }
    const key = path.slice(prefixPath.length).replace(/^\//, '')
    const op = classify(method, key, parsed.searchParams)
    if (!op) return errorResponse(405, 'MethodNotAllowed')
    opsSeen.push(op)

    const opFailure = opFailures.get(op)
    if (opFailure) return errorResponse(opFailure.status, opFailure.code)

    switch (op) {
      case 'HeadBucket':
        return new Response(null, { status: exists ? 200 : 404 })
      case 'CreateBucket':
        if (exists) return errorResponse(409, 'BucketAlreadyOwnedByYou')
        exists = true
        return new Response(null, { status: 200 })
      case 'DeleteBucket':
        if (!exists) return errorResponse(404, 'NoSuchBucket')
        if (objects.size > 0) return errorResponse(409, 'BucketNotEmpty')
        exists = false
        corsDoc = null
        return new Response(null, { status: 204 })
    }

    if (!exists) return errorResponse(404, 'NoSuchBucket')

    switch (op) {
      case 'PutBucketCors': {
        const body = init.body as unknown as Uint8Array | undefined
        corsDoc = body ? new TextDecoder().decode(body) : ''
        return new Response(null, { status: 200 })
      }
      case 'GetBucketCors':
        if (corsDoc === null)
          return errorResponse(404, 'NoSuchCORSConfiguration')
        return response(200, corsDoc)
      case 'GetBucketVersioning':
        return response(
          200,
          `<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            (versioning ? `<Status>${versioning}</Status>` : '') +
            `</VersioningConfiguration>`,
        )
      case 'ListObjectsV2':
        listCalls++
        return listing(parsed)
      case 'GetObject': {
        const found = objects.get(key)
        if (!found) return errorResponse(404, 'NoSuchKey')
        return new Response(
          found.body as unknown as ConstructorParameters<typeof Response>[0],
          { status: 200 },
        )
      }
      case 'HeadObject': {
        const found = objects.get(key)
        if (!found) return new Response(null, { status: 404 })
        return new Response(null, {
          status: 200,
          headers: ipfs ? { 'x-amz-meta-cid': 'bafyfakecid' } : {},
        })
      }
      case 'PutObject': {
        const body = init.body as unknown as Uint8Array | undefined
        store(key, body ? new Uint8Array(body) : new Uint8Array(0))
        return new Response(null, {
          status: 200,
          headers: ipfs ? { 'x-amz-meta-cid': 'bafyfakecid' } : {},
        })
      }
      case 'DeleteObject':
        if (!objects.delete(key)) return errorResponse(404, 'NoSuchKey')
        return new Response(null, { status: 204 })
    }
    return errorResponse(405, 'MethodNotAllowed')
  }

  function listing(parsed: URL): Response {
    const prefix = parsed.searchParams.get('prefix') ?? ''
    const delimiter = parsed.searchParams.get('delimiter') ?? ''
    const token = parsed.searchParams.get('continuation-token')
    const maxKeys = Number(parsed.searchParams.get('max-keys') ?? pageSize)

    const matching = [...objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()

    const contents: string[] = []
    const commonPrefixes = new Set<string>()
    const flat: string[] = []
    for (const key of matching) {
      if (delimiter) {
        const rest = key.slice(prefix.length)
        const cut = rest.indexOf(delimiter)
        if (cut >= 0) {
          commonPrefixes.add(prefix + rest.slice(0, cut + 1))
          continue
        }
      }
      flat.push(key)
    }

    const start = token ? Number(token) : 0
    const limit = Math.min(maxKeys, pageSize)
    const page = flat.slice(start, start + limit)
    const truncated = start + limit < flat.length

    for (const key of page) {
      const object = objects.get(key)!
      contents.push(
        `<Contents><Key>${xmlEscape(key)}</Key><Size>${object.body.length}</Size>` +
          (etagsHidden ? '' : `<ETag>&quot;${object.etag}&quot;</ETag>`) +
          `<LastModified>${object.lastModified}</LastModified></Contents>`,
      )
    }

    const prefixXml = [...commonPrefixes]
      .sort()
      .map(
        (p) =>
          `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`,
      )
      .join('')

    return response(
      200,
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
        `<KeyCount>${page.length}</KeyCount>` +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (truncated
          ? `<NextContinuationToken>${start + limit}</NextContinuationToken>`
          : '') +
        contents.join('') +
        prefixXml +
        `</ListBucketResult>`,
    )
  }

  return {
    fetch: fetchImpl,
    put(key, body) {
      store(
        key,
        typeof body === 'string' ? new TextEncoder().encode(body) : body,
      )
    },
    get: (key) => objects.get(key)?.body,
    has: (key) => objects.has(key),
    keys: () => [...objects.keys()].sort(),
    remove(key) {
      objects.delete(key)
    },
    requests: () => [...seen],
    resetRequests() {
      seen.length = 0
      opsSeen.length = 0
    },
    ops: () => [...opsSeen],
    count: (op) => opsSeen.filter((o) => o === op).length,
    listCalls: () => listCalls,
    exists: () => exists,
    setExists(value) {
      exists = value
    },
    cors: () => corsDoc,
    setVersioning(status) {
      versioning = status
    },
    ipfsMode(on) {
      ipfs = on
    },
    blockNetwork() {
      networkBlocked = true
    },
    allowNetwork() {
      networkBlocked = false
    },
    failWith(status, code) {
      failure = { status, code }
    },
    failOp(op, status, code) {
      opFailures.set(op, { status, code })
    },
    notImplemented(op) {
      opFailures.set(op, { status: 501, code: 'NotImplemented' })
    },
    clearFailure() {
      failure = null
      opFailures.clear()
    },
    setPageSize(n) {
      pageSize = n
    },
    hideEtags() {
      etagsHidden = true
    },
  }
}
