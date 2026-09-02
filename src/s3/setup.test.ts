import { describe, expect, it } from 'vitest'

import { createFakeBucket } from '../test/fake-bucket.ts'
import type { FetchLike } from './client.ts'
import {
  applyProvider,
  corsPolicyJson,
  CORS_ALLOWED_METHODS,
  emptyS3Form,
  formFromConfig,
  normalizeS3Config,
  testS3Connection,
  validateS3Form,
  type S3FormValues,
} from './setup.ts'

const BUCKET = 'test-bucket'

function form(overrides: Partial<S3FormValues> = {}): S3FormValues {
  return {
    ...emptyS3Form('other'),
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    ...overrides,
  }
}

describe('setup — validation', () => {
  it('accepts a complete form', () => {
    expect(validateS3Form(form())).toEqual({})
  })

  it('rejects an endpoint carrying a path', () => {
    expect(
      validateS3Form(form({ endpoint: 'https://s3.example.com/test-bucket' }))
        .endpoint,
    ).toBeTruthy()
    expect(
      validateS3Form(form({ endpoint: 'https://s3.example.com/' })).endpoint,
    ).toBeUndefined()
  })

  it('rejects an endpoint that is not a web address', () => {
    expect(
      validateS3Form(form({ endpoint: 'ftp://s3.example.com' })).endpoint,
    ).toBeTruthy()
    expect(
      validateS3Form(form({ endpoint: 'not a url' })).endpoint,
    ).toBeTruthy()
  })

  it('rejects a bucket name S3 itself would reject', () => {
    expect(validateS3Form(form({ bucket: 'Has-Capitals' })).bucket).toBeTruthy()
    expect(validateS3Form(form({ bucket: 'has spaces' })).bucket).toBeTruthy()
    expect(validateS3Form(form({ bucket: 'ab' })).bucket).toBeTruthy()
    expect(
      validateS3Form(form({ bucket: 'a'.repeat(63) })).bucket,
    ).toBeUndefined()
    expect(validateS3Form(form({ bucket: 'a'.repeat(64) })).bucket).toBeTruthy()
    expect(validateS3Form(form({ bucket: 'ok-name.1' })).bucket).toBeUndefined()
  })

  it('requires the region, and both halves of the key pair', () => {
    expect(validateS3Form(form({ region: '  ' })).region).toBeTruthy()
    expect(validateS3Form(form({ accessKeyId: '  ' })).accessKeyId).toBeTruthy()
    expect(
      validateS3Form(form({ secretAccessKey: '' })).secretAccessKey,
    ).toBeTruthy()
  })
})

describe('setup — normalisation', () => {
  it('trims credentials, which is the difference between working and a 403', () => {
    const config = normalizeS3Config(
      form({ accessKeyId: ' AKIAEXAMPLE\n', secretAccessKey: 'secret \n' }),
    )
    expect(config.accessKeyId).toBe('AKIAEXAMPLE')
    expect(config.secretAccessKey).toBe('secret')
  })

  it('supplies https and strips trailing slashes, however many were pasted', () => {
    expect(
      normalizeS3Config(form({ endpoint: 's3.example.com/' })).endpoint,
    ).toBe('https://s3.example.com')
    expect(
      normalizeS3Config(form({ endpoint: 'https://s3.example.com//' }))
        .endpoint,
    ).toBe('https://s3.example.com')
  })

  it('keeps an explicit http endpoint rather than silently upgrading it', () => {
    expect(
      normalizeS3Config(form({ endpoint: 'http://localhost:9000' })).endpoint,
    ).toBe('http://localhost:9000')
  })

  it('reduces a prefix to its real segments', () => {
    expect(normalizeS3Config(form({ prefix: '/a//b/' })).prefix).toBe('a/b')
    expect(normalizeS3Config(form({ prefix: '' })).prefix).toBe('')
  })

  it('round-trips through formFromConfig', () => {
    const config = normalizeS3Config(form({ prefix: 'chats' }))
    expect(normalizeS3Config(formFromConfig(config, 'other'))).toEqual(config)
  })

  it('defaults the prefix to empty, as the client does', () => {
    expect(emptyS3Form('filebase').prefix).toBe('')
  })
})

describe('setup — provider presets', () => {
  it('re-seeds the vendor fields and leaves the user’s typing alone', () => {
    const typed = form({
      bucket: 'mine',
      accessKeyId: 'key',
      secretAccessKey: 'sec',
    })
    const switched = applyProvider(typed, 'filebase')
    expect(switched.endpoint).toBe('https://s3.filebase.io')
    expect(switched.region).toBe('auto')
    expect(switched.bucket).toBe('mine')
    expect(switched.accessKeyId).toBe('key')
  })

  it('clears a previous vendor’s endpoint when there is no fixed one to use', () => {
    const filebase = applyProvider(form(), 'filebase')
    expect(applyProvider(filebase, 'garage').endpoint).toBe('')
  })

  it('re-seeds the region on every switch', () => {
    const garage = applyProvider(form(), 'garage')
    expect(garage.region).toBe('garage')
    expect(applyProvider(garage, 'seaweedfs').region).toBe('us-east-1')
  })

  it('follows the vendor’s addressing style', () => {
    expect(applyProvider(form(), 'aws').forcePathStyle).toBe(false)
    expect(applyProvider(form(), 'garage').forcePathStyle).toBe(true)
  })
})

describe('setup — the connection test', () => {
  function connect(fetchImpl: FetchLike) {
    return testS3Connection(normalizeS3Config(form()), fetchImpl)
  }

  function failMethod(
    base: FetchLike,
    method: string,
    status: number,
    code: string,
  ): FetchLike {
    return async (url, init) => {
      if ((init.method ?? 'GET') === method) {
        return new Response(`<Error><Code>${code}</Code></Error>`, { status })
      }
      return base(url, init)
    }
  }

  it('passes all four steps and leaves nothing behind', async () => {
    const bucket = createFakeBucket(BUCKET)
    expect(await connect(bucket.fetch)).toEqual({ ok: true })
    expect(bucket.keys()).toEqual([])
  })

  it('keeps the probe out of the subtree peers actually read', async () => {
    const bucket = createFakeBucket(BUCKET)
    await connect(bucket.fetch)
    const writes = bucket.requests().filter((line) => line.startsWith('PUT'))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('/zs-chats/.connection-test/')
    expect(writes[0]).not.toContain('/devices/')
  })

  it('reports a request that got no answer as blocked, at the step it happened', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.blockNetwork()
    expect(await connect(bucket.fetch)).toMatchObject({
      ok: false,
      failedStep: 'list',
      kind: 'blocked',
    })
  })

  it('names listing as the failure when only listing is refused', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.failWith(403, 'AccessDenied')
    expect(await connect(bucket.fetch)).toMatchObject({
      ok: false,
      failedStep: 'list',
      kind: 'denied',
      status: 403,
    })
  })

  it('separates read-only credentials from wrong ones', async () => {
    const bucket = createFakeBucket(BUCKET)
    expect(
      await connect(failMethod(bucket.fetch, 'PUT', 403, 'AccessDenied')),
    ).toMatchObject({
      ok: false,
      failedStep: 'write',
      kind: 'denied',
    })
  })

  it('separates credentials that cannot delete from ones that cannot write', async () => {
    const bucket = createFakeBucket(BUCKET)
    expect(
      await connect(failMethod(bucket.fetch, 'DELETE', 403, 'AccessDenied')),
    ).toMatchObject({
      ok: false,
      failedStep: 'delete',
      kind: 'denied',
    })
  })

  it('reports a skewed clock as its own thing, not as a rejected key', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.failWith(403, 'RequestTimeTooSkewed')
    expect(await connect(bucket.fetch)).toMatchObject({
      ok: false,
      kind: 'skew',
    })
  })

  it('reports a missing bucket as missing', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.failWith(404, 'NoSuchBucket')
    expect(await connect(bucket.fetch)).toMatchObject({
      ok: false,
      failedStep: 'list',
      kind: 'not-found',
    })
  })

  it('refuses a store that does not return what was written', async () => {
    const bucket = createFakeBucket(BUCKET)
    const mangling: FetchLike = async (url, init) => {
      const response = await bucket.fetch(url, init)
      if (
        (init.method ?? 'GET') === 'GET' &&
        url.includes('.connection-test')
      ) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      }
      return response
    }
    expect(await connect(mangling)).toMatchObject({
      ok: false,
      failedStep: 'read',
      sourceName: 'ContentMismatch',
    })
    expect(bucket.keys()).toEqual([])
  })

  it('tidies up the probe when the read fails outright', async () => {
    const bucket = createFakeBucket(BUCKET)
    let reads = 0
    const failingRead: FetchLike = async (url, init) => {
      if (
        (init.method ?? 'GET') === 'GET' &&
        url.includes('.connection-test')
      ) {
        reads++
        return new Response('<Error><Code>InternalError</Code></Error>', {
          status: 500,
        })
      }
      return bucket.fetch(url, init)
    }
    expect(await connect(failingRead)).toMatchObject({
      ok: false,
      failedStep: 'read',
    })
    expect(reads).toBe(1)
    expect(bucket.keys()).toEqual([])
  })
})

describe('setup — the CORS policy', () => {
  // Pinned to literals: this is the artifact the user copies into a provider,
  // and a wrong field fails later, in a browser, as a refusal it may not describe.
  const rule = () => JSON.parse(corsPolicyJson())[0]

  it('covers every method the client issues, HEAD included', () => {
    expect(rule().AllowedMethods).toEqual([...CORS_ALLOWED_METHODS])
    expect(rule().AllowedMethods).toEqual(['GET', 'PUT', 'DELETE', 'HEAD'])
  })

  it('allows the headers every signed request carries', () => {
    expect(rule().AllowedHeaders).toEqual(['*'])
  })

  it('exposes ETag', () => {
    expect(rule().ExposeHeaders).toEqual(['ETag'])
  })

  it('allows every origin by default and one on request', () => {
    expect(rule().AllowedOrigins).toEqual(['*'])
    expect(
      JSON.parse(corsPolicyJson(['https://example.com']))[0].AllowedOrigins,
    ).toEqual(['https://example.com'])
  })

  it('caches the preflight for an hour', () => {
    expect(rule().MaxAgeSeconds).toBe(3600)
  })
})
