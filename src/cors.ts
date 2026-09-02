// The client's CORS rule as the XML `PutBucketCors` takes, and the reverse
// for reading it back. Derived from `corsPolicyJson` rather than restated so
// the two cannot disagree.

import { corsPolicyJson } from './s3/setup.ts'
import { blocksOf, textOf, assertWellFormed } from './s3/xml.ts'

export interface CorsRule {
  allowedOrigins: string[]
  allowedMethods: string[]
  allowedHeaders: string[]
  exposeHeaders: string[]
  maxAgeSeconds?: number
}

interface JsonRule {
  AllowedOrigins: string[]
  AllowedMethods: string[]
  AllowedHeaders: string[]
  ExposeHeaders: string[]
  MaxAgeSeconds: number
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function corsRule(origins: readonly string[] = ['*']): CorsRule {
  const [rule] = JSON.parse(corsPolicyJson(origins)) as JsonRule[]
  return {
    allowedOrigins: rule.AllowedOrigins,
    allowedMethods: rule.AllowedMethods,
    allowedHeaders: rule.AllowedHeaders,
    exposeHeaders: rule.ExposeHeaders,
    maxAgeSeconds: rule.MaxAgeSeconds,
  }
}

export function corsConfigurationXml(
  origins: readonly string[] = ['*'],
): string {
  const rule = corsRule(origins)
  const el = (tag: string, values: readonly string[]) =>
    values.map((v) => `<${tag}>${escape(v)}</${tag}>`).join('')
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CORSRule>` +
    el('AllowedOrigin', rule.allowedOrigins) +
    el('AllowedMethod', rule.allowedMethods) +
    el('AllowedHeader', rule.allowedHeaders) +
    el('ExposeHeader', rule.exposeHeaders) +
    `<MaxAgeSeconds>${rule.maxAgeSeconds}</MaxAgeSeconds>` +
    `</CORSRule></CORSConfiguration>`
  )
}

export function parseCorsConfiguration(xml: string): CorsRule[] {
  assertWellFormed(xml, 'CORSConfiguration')
  return blocksOf(xml, 'CORSRule').map((block) => {
    const maxAge = textOf(block, 'MaxAgeSeconds')
    return {
      allowedOrigins: blocksOf(block, 'AllowedOrigin').map((s) => s.trim()),
      allowedMethods: blocksOf(block, 'AllowedMethod').map((s) =>
        s.trim().toUpperCase(),
      ),
      allowedHeaders: blocksOf(block, 'AllowedHeader').map((s) => s.trim()),
      exposeHeaders: blocksOf(block, 'ExposeHeader').map((s) => s.trim()),
      maxAgeSeconds: maxAge === '' ? undefined : Number(maxAge),
    }
  })
}

export interface CorsCoverage {
  ok: boolean
  /** What no single rule provided, in the words the user will look for. */
  missing: string[]
}

/**
 * Does some one rule let the app in? A browser matches one rule, so coverage
 * split across two rules is not coverage.
 */
export function corsCovers(
  rules: readonly CorsRule[],
  origins: readonly string[] = ['*'],
): CorsCoverage {
  const wanted = corsRule(origins)
  let best: string[] | null = null
  for (const rule of rules) {
    const missing: string[] = []
    const originOk =
      rule.allowedOrigins.includes('*') ||
      wanted.allowedOrigins.every((o) => rule.allowedOrigins.includes(o))
    if (!originOk) missing.push(`origin ${wanted.allowedOrigins.join(', ')}`)
    for (const method of wanted.allowedMethods) {
      if (!rule.allowedMethods.includes(method))
        missing.push(`method ${method}`)
    }
    if (!rule.allowedHeaders.includes('*')) missing.push('AllowedHeader *')
    if (
      !rule.exposeHeaders.some((h) => h.toLowerCase() === 'etag') &&
      !rule.exposeHeaders.includes('*')
    ) {
      missing.push('ExposeHeader ETag')
    }
    if (missing.length === 0) return { ok: true, missing: [] }
    if (best === null || missing.length < best.length) best = missing
  }
  return { ok: false, missing: best ?? ['any rule at all'] }
}
