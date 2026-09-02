import { describe, expect, it } from 'vitest'

import {
  DEFAULT_APP_URL,
  formFromOptions,
  missingForNonInteractive,
  parseCliArgs,
  USAGE,
} from './args.ts'

describe('args', () => {
  it('defaults to interactive, no QR, any origin, the production app', () => {
    const { options, errors } = parseCliArgs([])
    expect(errors).toEqual([])
    expect(options.json).toBe(false)
    expect(options.qr).toBe(false)
    expect(options.origins).toEqual(['*'])
    expect(options.appUrl).toBe(DEFAULT_APP_URL)
    expect(options.given).toEqual({})
  })

  it('reads keys from the environment when no flag is given, flag winning', () => {
    const env = {
      ZS_ACCESS_KEY_ID: 'envkey',
      ZS_SECRET_ACCESS_KEY: 'envsecret',
    }
    expect(parseCliArgs([], env).options.given).toEqual({
      accessKeyId: 'envkey',
      secretAccessKey: 'envsecret',
    })
    expect(
      parseCliArgs(['--access-key-id', 'flag'], env).options.given.accessKeyId,
    ).toBe('flag')
  })

  it('collects repeated origins', () => {
    expect(
      parseCliArgs(['--origin', 'https://a', '--origin', 'https://b']).options
        .origins,
    ).toEqual(['https://a', 'https://b'])
  })

  it('reduces --app-url to its origin', () => {
    expect(
      parseCliArgs(['--app-url', 'https://chat.example.com/some/path']).options
        .appUrl,
    ).toBe('https://chat.example.com')
    expect(parseCliArgs(['--app-url', 'nope']).errors[0]).toContain('--app-url')
  })

  it('rejects an unknown provider and an unknown flag', () => {
    expect(parseCliArgs(['--provider', 'dropbox']).errors[0]).toContain(
      '--provider',
    )
    expect(parseCliArgs(['--bogus']).errors).toHaveLength(1)
  })

  it('refuses contradictory path-style flags', () => {
    expect(
      parseCliArgs(['--path-style', '--no-path-style']).errors[0],
    ).toContain('contradict')
    expect(parseCliArgs(['--no-path-style']).options.given.forcePathStyle).toBe(
      false,
    )
  })

  it('overlays given values on the preset, prefix empty by default', () => {
    const { options } = parseCliArgs([
      '--provider',
      'filebase',
      '--bucket',
      'b',
    ])
    const form = formFromOptions(options, 'filebase')
    expect(form.endpoint).toBe('https://s3.filebase.io')
    expect(form.region).toBe('auto')
    expect(form.bucket).toBe('b')
    expect(form.prefix).toBe('')
    expect(form.forcePathStyle).toBe(true)
  })

  it('lists what --json cannot proceed without', () => {
    expect(missingForNonInteractive(parseCliArgs(['--json']).options)).toEqual([
      '--provider',
      '--access-key-id or ZS_ACCESS_KEY_ID',
      '--secret-access-key or ZS_SECRET_ACCESS_KEY',
      '--bucket',
    ])
    const r2 = parseCliArgs(['--json', '--provider', 'r2', '--bucket', 'b'], {
      ZS_ACCESS_KEY_ID: 'k',
      ZS_SECRET_ACCESS_KEY: 's',
    })
    expect(missingForNonInteractive(r2.options)).toEqual(['--endpoint'])
    const filebase = parseCliArgs(
      ['--json', '--provider', 'filebase', '--bucket', 'b'],
      {
        ZS_ACCESS_KEY_ID: 'k',
        ZS_SECRET_ACCESS_KEY: 's',
      },
    )
    expect(missingForNonInteractive(filebase.options)).toEqual([])
  })

  it('warns about shell history and the secret in --json output', () => {
    expect(USAGE).toContain('shell history')
    expect(USAGE).toContain('includes the secret')
    expect(USAGE).toContain('passkey')
  })
})
