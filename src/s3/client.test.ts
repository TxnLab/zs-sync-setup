import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createFakeBucket } from '../test/fake-bucket.ts'
import { MirrorIOError } from './errors.ts'
import {
  parseListing,
  S3Client,
  s3ErrorKind,
  type S3MirrorConfig,
} from './client.ts'

const BUCKET = 'test-bucket'

function config(overrides: Partial<S3MirrorConfig> = {}): S3MirrorConfig {
  return {
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    forcePathStyle: true,
    ...overrides,
  }
}

describe('client — objects', () => {
  it('round-trips bytes and keeps path separators as separators', async () => {
    const bucket = createFakeBucket(BUCKET)
    const client = new S3Client(config(), bucket.fetch)
    await client.putObject(['a', 'b c', 'd.age'], new Uint8Array([1, 2, 3]))
    expect(bucket.keys()).toEqual(['a/b c/d.age'])
    expect(await client.getObject(['a', 'b c', 'd.age'])).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(await client.getObject(['missing'])).toBeNull()
    await client.deleteObject(['a', 'b c', 'd.age'])
    await client.deleteObject(['a', 'b c', 'd.age'])
    expect(bucket.keys()).toEqual([])
  })

  it('writes under the prefix and reads back without it', async () => {
    const bucket = createFakeBucket(BUCKET)
    const client = new S3Client(config({ prefix: 'p/q' }), bucket.fetch)
    await client.putObject(['k'], new Uint8Array([1]))
    expect(bucket.keys()).toEqual(['p/q/k'])
    expect(client.label).toBe(`${BUCKET}/p/q`)
  })

  it('addresses virtual-host style when path style is switched off', async () => {
    const seen: string[] = []
    const client = new S3Client(
      config({ forcePathStyle: false }),
      async (url) => {
        seen.push(url)
        return new Response(null, { status: 200 })
      },
    )
    await client.putObject(['k'], new Uint8Array([1]))
    expect(seen[0]).toBe(`https://${BUCKET}.s3.example.com/k`)
  })

  it('sends the query string the signature was computed over', async () => {
    const bucket = createFakeBucket(BUCKET)
    const client = new S3Client(config(), bucket.fetch)
    await client.listObjects({ prefix: "it's", maxKeys: 1 })
    expect(bucket.requests()[0]).toBe(
      `GET /${BUCKET}?list-type=2&max-keys=1&prefix=it%27s`,
    )
  })
})

describe('client — listing', () => {
  it('follows continuation tokens and strips ETag quotes', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.setPageSize(2)
    for (const k of ['a/1', 'a/2', 'a/3']) bucket.put(k, k)
    const client = new S3Client(config(), bucket.fetch)
    const first = await client.listObjects({ prefix: 'a/' })
    expect(first.objects.map((o) => o.key)).toEqual(['a/1', 'a/2'])
    expect(first.objects[0].etag).not.toContain('"')
    expect(first.continuationToken).toBeTruthy()
    const second = await client.listObjects({
      prefix: 'a/',
      continuationToken: first.continuationToken,
    })
    expect(second.objects.map((o) => o.key)).toEqual(['a/3'])
    expect(second.continuationToken).toBeUndefined()
  })

  it('returns common prefixes with a delimiter', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.put('d/x/1', '1')
    bucket.put('d/y/1', '1')
    const client = new S3Client(config(), bucket.fetch)
    const page = await client.listObjects({ prefix: 'd/', delimiter: '/' })
    expect(page.commonPrefixes).toEqual(['d/x/', 'd/y/'])
    expect(page.objects).toEqual([])
  })

  it('rejects a malformed listing instead of reading it as empty', () => {
    expect(() => parseListing('<ListBucketResult><oops')).toThrow(MirrorIOError)
  })

  it('reads an empty listing as empty, not malformed', () => {
    const page = parseListing(
      '<?xml version="1.0"?><ListBucketResult xmlns="x"><IsTruncated>false</IsTruncated></ListBucketResult>',
    )
    expect(page).toEqual({
      objects: [],
      commonPrefixes: [],
      continuationToken: undefined,
    })
  })
})

describe('client — error mapping', () => {
  it('maps the taxonomy', () => {
    const cases: [number, string, string][] = [
      [403, 'RequestTimeTooSkewed', 'skew'],
      [404, '', 'not-found'],
      [200, 'NoSuchBucket', 'not-found'],
      [403, 'AccessDenied', 'denied'],
      [401, '', 'denied'],
      [429, '', 'locked'],
      [503, '', 'locked'],
      [500, 'SlowDown', 'locked'],
      [507, '', 'quota'],
      [500, '', 'transient'],
      [400, 'AuthorizationHeaderMalformed', 'other'],
    ]
    for (const [status, code, expected] of cases) {
      expect(s3ErrorKind(status, code), `${status} ${code}`).toBe(expected)
    }
  })

  it('reports a request that got no answer as blocked', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.blockNetwork()
    const client = new S3Client(config(), bucket.fetch)
    await expect(client.getObject(['k'])).rejects.toMatchObject({
      kind: 'blocked',
    })
  })

  it('carries the status and code on the error', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.failWith(400, 'AuthorizationHeaderMalformed')
    const client = new S3Client(config(), bucket.fetch)
    await expect(client.getObject(['k'])).rejects.toMatchObject({
      kind: 'other',
      sourceName: 'AuthorizationHeaderMalformed',
      status: 400,
    })
  })

  it('does not follow a redirect, so a wrong-region 301 stays visible', async () => {
    let init: RequestInit | undefined
    const client = new S3Client(config(), async (_url, i) => {
      init = i
      return new Response(null, { status: 200 })
    })
    await client.headBucket()
    expect(init?.redirect).toBe('manual')
  })
})

describe('client — bucket operations', () => {
  it('reports whether the bucket exists without throwing', async () => {
    const bucket = createFakeBucket(BUCKET)
    const client = new S3Client(config(), bucket.fetch)
    expect(await client.headBucket()).toBe(200)
    bucket.setExists(false)
    expect(await client.headBucket()).toBe(404)
    bucket.failOp('HeadBucket', 403, 'AccessDenied')
    expect(await client.headBucket()).toBe(403)
  })

  it('creates the bucket with a LocationConstraint only outside us-east-1 and auto', async () => {
    const bodies: (string | undefined)[] = []
    const capture = async (_url: string, init: RequestInit) => {
      const body = init.body as unknown as Uint8Array | undefined
      bodies.push(body ? new TextDecoder().decode(body) : undefined)
      return new Response(null, { status: 200 })
    }
    await new S3Client(config({ region: 'us-east-1' }), capture).createBucket()
    await new S3Client(config({ region: 'auto' }), capture).createBucket()
    await new S3Client(config({ region: 'eu-west-1' }), capture).createBucket()
    await new S3Client(config({ region: 'garage' }), capture).createBucket()
    expect(bodies[0]).toBeUndefined()
    expect(bodies[1]).toBeUndefined()
    expect(bodies[2]).toContain(
      '<LocationConstraint>eu-west-1</LocationConstraint>',
    )
    expect(bodies[3]).toContain(
      '<LocationConstraint>garage</LocationConstraint>',
    )
  })

  it('surfaces the create error code', async () => {
    const bucket = createFakeBucket(BUCKET)
    const client = new S3Client(config(), bucket.fetch)
    await expect(client.createBucket()).rejects.toMatchObject({
      sourceName: 'BucketAlreadyOwnedByYou',
      status: 409,
    })
  })

  it('puts the CORS document on ?cors with a Content-MD5, and reads it back', async () => {
    const bucket = createFakeBucket(BUCKET)
    let headers: Headers | undefined
    const spy = async (url: string, init: RequestInit) => {
      if (url.includes('cors=') && init.method === 'PUT')
        headers = new Headers(init.headers)
      return bucket.fetch(url, init)
    }
    const client = new S3Client(config(), spy)
    expect(await client.getBucketCors()).toBeNull()
    await client.putBucketCors('<CORSConfiguration></CORSConfiguration>')
    expect(bucket.requests().at(-1)).toBe(`PUT /${BUCKET}?cors=`)
    expect(headers?.get('content-md5')).toBe(
      createHash('md5')
        .update('<CORSConfiguration></CORSConfiguration>')
        .digest('base64'),
    )
    expect(headers?.get('authorization')).toContain('content-md5;')
    expect(await client.getBucketCors()).toBe(
      '<CORSConfiguration></CORSConfiguration>',
    )
  })

  it('reads the versioning document', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.setVersioning('Enabled')
    const client = new S3Client(config(), bucket.fetch)
    expect(await client.getBucketVersioning()).toContain(
      '<Status>Enabled</Status>',
    )
  })

  it('exposes response headers on a write, for the IPFS content id', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.ipfsMode(true)
    const client = new S3Client(config(), bucket.fetch)
    const headers = await client.putObjectWithHeaders(
      ['k'],
      new Uint8Array([1]),
    )
    expect(headers.get('x-amz-meta-cid')).toBe('bafyfakecid')
    expect((await client.headObject(['k']))?.get('x-amz-meta-cid')).toBe(
      'bafyfakecid',
    )
    expect(await client.headObject(['nope'])).toBeNull()
  })

  it('deletes a bucket, treating an absent one as success', async () => {
    const bucket = createFakeBucket(BUCKET)
    const client = new S3Client(config(), bucket.fetch)
    await client.deleteBucket()
    expect(bucket.exists()).toBe(false)
    await client.deleteBucket()
  })
})
