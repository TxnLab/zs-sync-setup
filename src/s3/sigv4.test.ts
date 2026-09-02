import { describe, expect, it } from 'vitest'

import vectors from '../../test/vectors/sigv4-vectors.json'
import {
  amzDate,
  canonicalPath,
  canonicalQueryString,
  EMPTY_PAYLOAD_SHA256,
  sha256Hex,
  signRequest,
  signingKey,
  uriEncode,
} from './sigv4.ts'

describe('sigv4 — golden vectors', () => {
  it('is the schema this test expects', () => {
    expect(vectors.version).toBe(1)
    expect(vectors.cases.length).toBeGreaterThan(0)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    'reproduces AWS’s published signature for %s',
    (_name, testCase) => {
      const signed = signRequest({
        request: {
          method: testCase.method,
          path: canonicalPath(testCase.pathSegments),
          query: testCase.query as [string, string][],
          headers: testCase.headers as Record<string, string>,
          payloadSha256:
            testCase.payload === ''
              ? EMPTY_PAYLOAD_SHA256
              : sha256Hex(testCase.payload),
        },
        credentials: vectors.credentials,
        region: vectors.region,
        service: vectors.service,
        host: vectors.host,
        now: new Date(vectors.now),
      })

      // Asserted separately so a failure localises to one side of the HMAC chain.
      expect(sha256Hex(signed.canonicalRequest)).toBe(
        testCase.canonicalRequestSha256,
      )
      expect(signed.signature).toBe(testCase.signature)
    },
  )
})

describe('sigv4 — encoding', () => {
  it('encodes the characters encodeURIComponent leaves alone', () => {
    expect(uriEncode("!'()*", true)).toBe('%21%27%28%29%2A')
    expect(encodeURIComponent("!'()*")).toBe("!'()*")
  })

  it('leaves RFC 3986 unreserved characters alone', () => {
    expect(uriEncode('azAZ09-_.~', true)).toBe('azAZ09-_.~')
  })

  it('encodes a slash only when asked', () => {
    expect(uriEncode('a/b', false)).toBe('a/b')
    expect(uriEncode('a/b', true)).toBe('a%2Fb')
  })

  it('encodes each path segment but keeps the separators', () => {
    expect(canonicalPath(['zs-chats', 'devices', 'aa bb', 'head.age'])).toBe(
      '/zs-chats/devices/aa%20bb/head.age',
    )
  })

  it('encodes multi-byte characters as UTF-8 bytes', () => {
    expect(uriEncode('é', true)).toBe('%C3%A9')
  })

  it('renders an empty path as a bare slash', () => {
    expect(canonicalPath([])).toBe('/')
  })

  it('sorts query parameters by their ENCODED name, then value', () => {
    expect(
      canonicalQueryString([
        ['prefix', 'J'],
        ['max-keys', '2'],
      ]),
    ).toBe('max-keys=2&prefix=J')
    expect(
      canonicalQueryString([
        ['a', 'z'],
        ['a', 'b'],
      ]),
    ).toBe('a=b&a=z')
  })

  it('sorts AFTER encoding, on a pair where the two orders disagree', () => {
    // `:` sorts after `0` raw and before it as `%3A`.
    expect(
      canonicalQueryString([
        ['a:', '2'],
        ['a0', '1'],
      ]),
    ).toBe('a%3A=2&a0=1')
  })

  it('encodes a slash INSIDE a path segment', () => {
    expect(canonicalPath(['a/b'])).toBe('/a%2Fb')
    expect(canonicalPath(['zs-chats', 'a/b.age'])).toBe('/zs-chats/a%2Fb.age')
  })

  it('keeps a valueless parameter as name=', () => {
    // The subresource form (`?cors`, `?versioning`) signs with a trailing `=`.
    expect(canonicalQueryString([['lifecycle', '']])).toBe('lifecycle=')
  })
})

describe('sigv4 — the signed request', () => {
  const base = {
    credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
    region: 'auto',
    service: 's3',
    host: 'bucket.s3.filebase.io',
    now: new Date('2026-08-21T12:34:56.000Z'),
  }

  it('never returns a host header, because fetch refuses to set one', () => {
    const signed = signRequest({
      ...base,
      request: {
        method: 'GET',
        path: '/k',
        payloadSha256: EMPTY_PAYLOAD_SHA256,
      },
    })
    expect(signed.headers).not.toHaveProperty('host')
    expect(signed.canonicalRequest).toContain('host:bucket.s3.filebase.io')
    expect(signed.headers.authorization).toContain('SignedHeaders=host;')
  })

  it('carries the real body hash, not UNSIGNED-PAYLOAD', () => {
    const signed = signRequest({
      ...base,
      request: { method: 'PUT', path: '/k', payloadSha256: sha256Hex('body') },
    })
    expect(signed.headers['x-amz-content-sha256']).toBe(sha256Hex('body'))
  })

  it('scopes the credential to date, region and service', () => {
    const signed = signRequest({
      ...base,
      request: {
        method: 'GET',
        path: '/k',
        payloadSha256: EMPTY_PAYLOAD_SHA256,
      },
    })
    expect(signed.headers.authorization).toContain(
      'Credential=AKID/20260821/auto/s3/aws4_request',
    )
    expect(signed.headers['x-amz-date']).toBe('20260821T123456Z')
  })

  it('signs a session token when one is present, and omits it otherwise', () => {
    const withToken = signRequest({
      ...base,
      credentials: { ...base.credentials, sessionToken: 'TOKEN' },
      request: {
        method: 'GET',
        path: '/k',
        payloadSha256: EMPTY_PAYLOAD_SHA256,
      },
    })
    expect(withToken.headers['x-amz-security-token']).toBe('TOKEN')
    expect(withToken.headers.authorization).toContain('x-amz-security-token')

    const without = signRequest({
      ...base,
      request: {
        method: 'GET',
        path: '/k',
        payloadSha256: EMPTY_PAYLOAD_SHA256,
      },
    })
    expect(without.headers).not.toHaveProperty('x-amz-security-token')
  })

  it('normalises header names to lower case and collapses value whitespace', () => {
    const signed = signRequest({
      ...base,
      request: {
        method: 'GET',
        path: '/k',
        headers: { 'X-Amz-Meta-Foo': '  a   b  ' },
        payloadSha256: EMPTY_PAYLOAD_SHA256,
      },
    })
    expect(signed.canonicalRequest).toContain('x-amz-meta-foo:a b\n')
  })

  it('derives a different key per date, region and service', () => {
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
    const a = hex(signingKey('SECRET', '20260821', 'auto', 's3'))
    expect(a).not.toBe(hex(signingKey('SECRET', '20260822', 'auto', 's3')))
    expect(a).not.toBe(hex(signingKey('SECRET', '20260821', 'us-east-1', 's3')))
    expect(a).not.toBe(hex(signingKey('SECRET', '20260821', 'auto', 'sqs')))
  })

  it('formats the timestamp as AWS expects', () => {
    expect(amzDate(new Date('2026-01-02T03:04:05.678Z'))).toEqual({
      amzDate: '20260102T030405Z',
      dateStamp: '20260102',
    })
  })

  it('knows the empty-payload hash', () => {
    expect(sha256Hex('')).toBe(EMPTY_PAYLOAD_SHA256)
  })
})
