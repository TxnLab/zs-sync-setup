import { describe, expect, it } from 'vitest'

import {
  httpFacts,
  httpLabel,
  probeFailure,
  RERUN,
  signingProblem,
  unreachable,
} from './report.ts'
import { MirrorIOError } from './s3/errors.ts'

describe('report — probe failures', () => {
  const endpoint = 'https://s3.example.com'

  it('says all four passed', () => {
    expect(probeFailure({ ok: true }, 'other', endpoint)).toContain(
      'all four passed',
    )
  })

  it('names the underlying error, not the wrapper, when nothing answered', () => {
    const wrapped = new MirrorIOError('blocked', 'TypeError', {
      cause: new TypeError('fetch failed'),
    })
    expect(unreachable(endpoint, wrapped)).toContain(
      '(TypeError — fetch failed)',
    )
  })

  it('does not call a network failure CORS', () => {
    const text = probeFailure(
      {
        ok: false,
        failedStep: 'list',
        kind: 'blocked',
        sourceName: 'TypeError',
      },
      'other',
      endpoint,
    )
    expect(text).toContain(endpoint)
    expect(text).toContain('not CORS')
  })

  it('keys a 403 on the step it happened at', () => {
    expect(
      probeFailure(
        { ok: false, failedStep: 'list', kind: 'denied' },
        'other',
        endpoint,
      ),
    ).toContain('list')
    expect(
      probeFailure(
        { ok: false, failedStep: 'write', kind: 'denied' },
        'other',
        endpoint,
      ),
    ).toContain('not write')
    expect(
      probeFailure(
        { ok: false, failedStep: 'delete', kind: 'denied' },
        'other',
        endpoint,
      ),
    ).toContain('not delete')
  })

  it('prefers a known signing code over the step wording, with the provider’s region hint', () => {
    const text = probeFailure(
      {
        ok: false,
        failedStep: 'list',
        kind: 'other',
        sourceName: 'AuthorizationHeaderMalformed',
        status: 400,
      },
      'filebase',
      endpoint,
    )
    expect(text).toContain('auto')
    expect(text).toContain('HTTP 400 AuthorizationHeaderMalformed')
  })

  it('says the clock, not the keys, for skew', () => {
    expect(
      probeFailure(
        { ok: false, failedStep: 'list', kind: 'skew' },
        'other',
        endpoint,
      ),
    ).toContain('clock')
  })

  it('names a store that returns different bytes', () => {
    expect(
      probeFailure(
        {
          ok: false,
          failedStep: 'read',
          kind: 'other',
          sourceName: 'ContentMismatch',
        },
        'other',
        endpoint,
      ),
    ).toContain('different bytes')
  })

  it('reports a missing bucket at the list step', () => {
    expect(
      probeFailure(
        { ok: false, failedStep: 'list', kind: 'not-found', status: 404 },
        'other',
        endpoint,
      ),
    ).toContain('No bucket')
  })
})

describe('report — helpers', () => {
  it('formats what the wire said', () => {
    expect(httpLabel({ status: 403, code: 'AccessDenied' })).toBe(
      ' (HTTP 403 AccessDenied)',
    )
    expect(httpLabel({ status: 403 })).toBe(' (HTTP 403)')
    expect(httpLabel(undefined)).toBe('')
  })

  it('reads facts off a MirrorIOError and nothing else', () => {
    expect(
      httpFacts(new MirrorIOError('denied', 'AccessDenied', { status: 403 })),
    ).toEqual({
      status: 403,
      code: 'AccessDenied',
    })
    expect(
      httpFacts(new MirrorIOError('other', 'HTTP 418', { status: 418 })),
    ).toEqual({ status: 418, code: undefined })
    expect(httpFacts(new Error('x'))).toBeUndefined()
    expect(httpFacts(new MirrorIOError('blocked', 'TypeError'))).toBeUndefined()
  })

  it('knows the codes whose obvious reading is wrong', () => {
    expect(signingProblem('SignatureDoesNotMatch', 'other')).toContain(
      'secret key',
    )
    expect(signingProblem('InvalidAccessKeyId', 'other')).toContain(
      'access key ID',
    )
    expect(signingProblem('PermanentRedirect', 'aws')).toContain('region')
    expect(signingProblem('AccessDenied', 'other')).toBeNull()
  })

  it('ends every hard failure with the re-run instruction', () => {
    expect(RERUN).toBe('Fix that, then re-run the same command.')
  })
})
