import { describe, expect, it } from 'vitest'

import {
  corsConfigurationXml,
  corsCovers,
  corsRule,
  parseCorsConfiguration,
} from './cors.ts'
import { corsPolicyJson } from './s3/setup.ts'

describe('cors — XML and JSON say the same thing', () => {
  it('emits every field of the client’s JSON rule', () => {
    const json = JSON.parse(corsPolicyJson())[0]
    const [rule] = parseCorsConfiguration(corsConfigurationXml())
    expect(rule.allowedOrigins).toEqual(json.AllowedOrigins)
    expect(rule.allowedMethods).toEqual(json.AllowedMethods)
    expect(rule.allowedHeaders).toEqual(json.AllowedHeaders)
    expect(rule.exposeHeaders).toEqual(json.ExposeHeaders)
    expect(rule.maxAgeSeconds).toBe(json.MaxAgeSeconds)
  })

  it('narrows to the requested origins', () => {
    const [rule] = parseCorsConfiguration(
      corsConfigurationXml(['https://zerosignal.ai']),
    )
    expect(rule.allowedOrigins).toEqual(['https://zerosignal.ai'])
  })

  it('escapes what XML needs escaped', () => {
    expect(corsConfigurationXml(['https://a.example/?x=1&y=2'])).toContain(
      '&amp;',
    )
  })

  it('carries the S3 namespace AWS requires', () => {
    expect(corsConfigurationXml()).toContain(
      'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"',
    )
  })
})

describe('cors — coverage', () => {
  it('accepts its own rule', () => {
    expect(corsCovers([corsRule()]).ok).toBe(true)
    expect(
      corsCovers(
        [corsRule(['https://zerosignal.ai'])],
        ['https://zerosignal.ai'],
      ).ok,
    ).toBe(true)
    expect(corsCovers([corsRule()], ['https://zerosignal.ai']).ok).toBe(true)
  })

  it('names the missing method of a read-only preset', () => {
    const readOnly = { ...corsRule(), allowedMethods: ['GET', 'HEAD'] }
    const coverage = corsCovers([readOnly])
    expect(coverage.ok).toBe(false)
    expect(coverage.missing).toEqual(['method PUT', 'method DELETE'])
  })

  it('does not accept coverage split across two rules', () => {
    const gets = { ...corsRule(), allowedMethods: ['GET', 'HEAD'] }
    const puts = { ...corsRule(), allowedMethods: ['PUT', 'DELETE'] }
    expect(corsCovers([gets, puts]).ok).toBe(false)
  })

  it('requires the wildcard header and an exposed ETag', () => {
    expect(
      corsCovers([{ ...corsRule(), allowedHeaders: ['content-type'] }]).missing,
    ).toContain('AllowedHeader *')
    expect(
      corsCovers([{ ...corsRule(), exposeHeaders: [] }]).missing,
    ).toContain('ExposeHeader ETag')
    expect(corsCovers([{ ...corsRule(), exposeHeaders: ['etag'] }]).ok).toBe(
      true,
    )
  })

  it('reports a narrower origin than requested', () => {
    const narrow = corsRule(['https://other.example'])
    expect(corsCovers([narrow], ['https://zerosignal.ai']).missing).toEqual([
      'origin https://zerosignal.ai',
    ])
    expect(corsCovers([narrow]).ok).toBe(false)
  })

  it('reports no rules at all', () => {
    expect(corsCovers([]).missing).toEqual(['any rule at all'])
  })

  it('parses a document with several rules and odd casing', () => {
    const xml =
      '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>get</AllowedMethod></CORSRule>' +
      '<CORSRule><AllowedOrigin>https://a</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><MaxAgeSeconds>5</MaxAgeSeconds></CORSRule></CORSConfiguration>'
    const rules = parseCorsConfiguration(xml)
    expect(rules).toHaveLength(2)
    expect(rules[0].allowedMethods).toEqual(['GET'])
    expect(rules[0].maxAgeSeconds).toBeUndefined()
    expect(rules[1].maxAgeSeconds).toBe(5)
  })
})
