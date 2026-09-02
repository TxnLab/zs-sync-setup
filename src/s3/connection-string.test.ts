import { describe, expect, it } from 'vitest'
import { base64urlnopad } from '@scure/base'

import vectors from '../../test/vectors/connection-strings.json'
import {
  connectionDeepLink,
  connectionStringFromFragment,
  decodeConnectionString,
  encodeConnectionString,
} from './connection-string.ts'
import type { S3MirrorConfig } from './client.ts'
import type { S3ProviderId } from './providers.ts'

const CONFIG: S3MirrorConfig = {
  endpoint: 'https://s3.filebase.io',
  region: 'auto',
  bucket: 'mine',
  prefix: 'chats',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'shhhh',
  forcePathStyle: true,
}

/** The payload as it actually rides, for assertions about what is NOT in it. */
function payloadOf(connectionString: string): Record<string, unknown> {
  const body = connectionString.slice(connectionString.indexOf(':') + 1)
  return JSON.parse(new TextDecoder().decode(base64urlnopad.decode(body)))
}

function wrap(payload: unknown): string {
  return `zsmirror1:${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))}`
}

describe('connection string — lockstep with the client', () => {
  it('is the schema this test expects', () => {
    expect(vectors.version).toBe(1)
    expect(vectors.cases.length).toBeGreaterThan(0)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    'encodes %s exactly as the client does',
    (_name, c) => {
      expect(
        encodeConnectionString(
          c.config as S3MirrorConfig,
          c.providerId as S3ProviderId,
        ),
      ).toBe(c.encoded)
    },
  )

  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    'decodes the client’s string for %s to what the client decodes',
    (_name, c) => {
      const decoded = decodeConnectionString(c.encoded)
      expect(decoded.ok).toBe(true)
      if (!decoded.ok) return
      expect(decoded.providerId).toBe(c.decoded.providerId)
      expect(decoded.config).toEqual(c.decoded.config)
    },
  )
})

describe('connection string — round trip', () => {
  it('carries every field the mirror needs, unchanged', () => {
    const decoded = decodeConnectionString(
      encodeConnectionString(CONFIG, 'filebase'),
    )
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.config).toEqual(CONFIG)
    expect(decoded.providerId).toBe('filebase')
  })

  it('carries the provider rather than guessing it from the endpoint', () => {
    const decoded = decodeConnectionString(
      encodeConnectionString(
        { ...CONFIG, endpoint: 'https://storage.example.com' },
        'garage',
      ),
    )
    expect(decoded.ok && decoded.providerId).toBe('garage')
  })

  it('defaults path style ON when the flag is absent, and only `false` turns it off', () => {
    const without = decodeConnectionString(
      encodeConnectionString({ ...CONFIG, forcePathStyle: undefined }, 'other'),
    )
    expect(without.ok && without.config.forcePathStyle).toBe(true)

    const off = decodeConnectionString(
      encodeConnectionString({ ...CONFIG, forcePathStyle: false }, 'aws'),
    )
    expect(off.ok && off.config.forcePathStyle).toBe(false)
    expect(
      payloadOf(
        encodeConnectionString({ ...CONFIG, forcePathStyle: false }, 'aws'),
      ).forcePathStyle,
    ).toBe(false)
    expect(
      payloadOf(encodeConnectionString(CONFIG, 'filebase')),
    ).not.toHaveProperty('forcePathStyle')
  })

  it('treats a missing prefix as no prefix, not as undefined', () => {
    const decoded = decodeConnectionString(
      encodeConnectionString({ ...CONFIG, prefix: undefined }, 'other'),
    )
    expect(decoded.ok && decoded.config.prefix).toBe('')
  })

  it('survives the whitespace a copy-paste adds', () => {
    const decoded = decodeConnectionString(
      `\n  ${encodeConnectionString(CONFIG, 'filebase')}  \n`,
    )
    expect(decoded.ok && decoded.config.bucket).toBe('mine')
  })

  it('trims each field, not only the envelope', () => {
    // A padded field is signed VERBATIM and comes back as a 403 that reads like a wrong key.
    const decoded = decodeConnectionString(
      wrap({
        ...CONFIG,
        endpoint: ' https://s3.filebase.io ',
        region: ' auto\n',
        bucket: '\tmine ',
        accessKeyId: ' AKIAEXAMPLE\n',
        secretAccessKey: 'shhhh ',
      }),
    )
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.config).toMatchObject({
      endpoint: 'https://s3.filebase.io',
      region: 'auto',
      bucket: 'mine',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'shhhh',
    })
  })

  it('normalises the prefix the way the form would have', () => {
    const decoded = decodeConnectionString(
      wrap({ ...CONFIG, prefix: ' /chats//work/ ' }),
    )
    expect(decoded.ok && decoded.config.prefix).toBe('chats/work')
  })

  it('never transports a session token, in either direction', () => {
    const encoded = encodeConnectionString(
      { ...CONFIG, sessionToken: 'temporary' },
      'aws',
    )
    expect(payloadOf(encoded)).not.toHaveProperty('sessionToken')
    const decoded = decodeConnectionString(
      wrap({ ...CONFIG, sessionToken: 'temporary' }),
    )
    expect(decoded.ok && decoded.config.sessionToken).toBeUndefined()
  })

  it('falls back to the generic preset for a provider id it does not know', () => {
    const decoded = decodeConnectionString(
      wrap({ ...CONFIG, providerId: 'not-a-provider' }),
    )
    expect(decoded.ok && decoded.providerId).toBe('other')
  })
})

describe('connection string — refusals', () => {
  it('names a string that is simply something else', () => {
    for (const junk of ['', 'hello', 'https://s3.example.com', 'zsmirror']) {
      expect(decodeConnectionString(junk)).toEqual({
        ok: false,
        reason: 'not-a-connection-string',
      })
    }
  })

  it('tells a newer format apart from a broken one', () => {
    expect(decodeConnectionString('zsmirror2:anything')).toEqual({
      ok: false,
      reason: 'newer-version',
    })
    // Equality, not "greater than": a `zsmirror0:` payload is not this version either.
    expect(
      decodeConnectionString(
        `zsmirror0:${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(CONFIG)))}`,
      ).ok,
    ).toBe(false)
  })

  it('reports a truncated string as damaged rather than as the wrong thing', () => {
    const whole = encodeConnectionString(CONFIG, 'filebase')
    expect(decodeConnectionString(whole.slice(0, whole.length - 12))).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(decodeConnectionString('zsmirror1:!!!not-base64!!!')).toEqual({
      ok: false,
      reason: 'malformed',
    })
    const notJson = base64urlnopad.encode(
      new TextEncoder().encode('plain text'),
    )
    expect(decodeConnectionString(`zsmirror1:${notJson}`)).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('refuses a payload missing any field the transport cannot work without', () => {
    for (const missing of [
      'endpoint',
      'region',
      'bucket',
      'accessKeyId',
      'secretAccessKey',
    ]) {
      const partial: Record<string, unknown> = { ...CONFIG }
      delete partial[missing]
      expect(decodeConnectionString(wrap(partial)), missing).toEqual({
        ok: false,
        reason: 'incomplete',
      })
    }
  })

  it('treats a blank field as missing, not as present', () => {
    expect(decodeConnectionString(wrap({ ...CONFIG, bucket: '   ' }))).toEqual({
      ok: false,
      reason: 'incomplete',
    })
  })

  it('calls any non-object payload damaged, not incomplete', () => {
    for (const body of ['null', '42', '"a string"', '[1,2]']) {
      const encoded = `zsmirror1:${base64urlnopad.encode(new TextEncoder().encode(body))}`
      expect(decodeConnectionString(encoded), body).toEqual({
        ok: false,
        reason: 'malformed',
      })
    }
  })
})

describe('connection string — the deep link', () => {
  it('puts the credential in the fragment, never the query', () => {
    const string = encodeConnectionString(CONFIG, 'filebase')
    const link = connectionDeepLink('https://chat.example.com', string)
    const url = new URL(link)
    expect(url.pathname).toBe('/sync')
    expect(url.search).toBe('')
    expect(connectionStringFromFragment(url.hash)).toBe(string)
    expect(link.slice(0, link.indexOf('#'))).not.toContain('zsmirror')
  })

  it('uses the `c=` form the /sync route reads, not a bare fragment', () => {
    const link = connectionDeepLink('https://zerosignal.ai', 'zsmirror1:abc')
    expect(link).toBe('https://zerosignal.ai/sync#c=zsmirror1%3Aabc')
    expect(connectionStringFromFragment('#zsmirror1:abc')).toBeNull()
  })

  it('reads a fragment with or without its leading hash', () => {
    expect(connectionStringFromFragment('#c=zsmirror1:abc')).toBe(
      'zsmirror1:abc',
    )
    expect(connectionStringFromFragment('c=zsmirror1:abc')).toBe(
      'zsmirror1:abc',
    )
  })

  it('survives a payload outside the base64url alphabet', () => {
    // `URLSearchParams` would turn an unescaped `+` into a space.
    const awkward = 'zsmirror1:a+b/c=d&e'
    const link = connectionDeepLink('https://chat.example.com', awkward)
    expect(connectionStringFromFragment(new URL(link).hash)).toBe(awkward)
  })

  it('answers null when there is nothing to read', () => {
    expect(connectionStringFromFragment('')).toBeNull()
    expect(connectionStringFromFragment('#')).toBeNull()
    expect(connectionStringFromFragment('#other=1')).toBeNull()
    expect(connectionStringFromFragment('#c=')).toBeNull()
  })
})
