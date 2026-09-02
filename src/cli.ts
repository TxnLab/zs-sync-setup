#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import * as p from '@clack/prompts'
import QRCode from 'qrcode'

import {
  formFromOptions,
  missingForNonInteractive,
  parseCliArgs,
  USAGE,
  type CliOptions,
} from './args.ts'
import { runBucketSetup, STEP_TITLES, type StepResult } from './bucket-setup.ts'
import { composeHandoff, suggestBucketName } from './handoff.ts'
import { notesFor } from './provider-notes.ts'
import { PROBE_LABELS, PROBE_ORDER, RERUN } from './report.ts'
import {
  endpointCautions,
  providerById,
  providersInCategory,
  S3_PROVIDER_CATEGORIES,
  type S3ProviderId,
} from './s3/providers.ts'
import {
  BUCKET_RE,
  normalizeS3Config,
  validateS3Form,
  type S3ConnectionTest,
} from './s3/setup.ts'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

const BEARER_LINE =
  'That string is a bearer credential for the bucket: anyone who has it can read and write it. Treat it like a password.'

async function main(): Promise<number> {
  const { options, errors } = parseCliArgs(process.argv.slice(2), process.env)
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (options.version) {
    console.log(version)
    return 0
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(error)
    console.error(`\n${USAGE}`)
    return 2
  }
  return options.json ? runJson(options) : runInteractive(options)
}

async function runJson(options: CliOptions): Promise<number> {
  const missing = missingForNonInteractive(options)
  if (missing.length > 0) {
    console.error(`--json needs: ${missing.join(', ')}`)
    return 2
  }
  const providerId = options.providerId as S3ProviderId
  const form = formFromOptions(options, providerId)
  const invalid = validateS3Form(form)
  if (Object.keys(invalid).length > 0) {
    console.log(JSON.stringify({ ok: false, errors: invalid }, null, 2))
    return 2
  }
  const config = normalizeS3Config(form)
  const outcome = await runBucketSetup({
    config,
    providerId,
    origins: options.origins,
  })
  const handoff = outcome.ok
    ? composeHandoff(config, providerId, options.appUrl)
    : undefined
  console.log(
    JSON.stringify(
      {
        ok: outcome.ok,
        providerId,
        config,
        cautions: endpointCautions(config.endpoint),
        steps: outcome.steps,
        connectionString: handoff?.connectionString,
        link: handoff?.link,
      },
      null,
      2,
    ),
  )
  return outcome.ok ? 0 : 1
}

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Cancelled. Nothing was changed.')
    process.exit(130)
  }
  return value as T
}

async function runInteractive(options: CliOptions): Promise<number> {
  p.intro(`ZeroSignal synced storage setup v${version}`)

  const providerId =
    options.providerId ??
    answer(
      await p.select<S3ProviderId>({
        message: 'Where is the bucket?',
        options: S3_PROVIDER_CATEGORIES.flatMap((category) =>
          providersInCategory(category.id).map((provider) => ({
            value: provider.id,
            label: provider.label,
            hint: category.label,
          })),
        ),
      }),
    )
  const provider = providerById(providerId)
  const notes = notesFor(providerId)
  const form = formFromOptions(options, providerId)

  if (!form.endpoint.trim()) {
    form.endpoint = answer(
      await p.text({
        message: 'Endpoint (host only)',
        placeholder: provider.endpointPlaceholder,
        validate: (value) =>
          validateS3Form({ ...form, endpoint: value ?? '' }).endpoint,
      }),
    )
  }
  if (provider.regionEditable && options.given.region === undefined) {
    form.region = answer(
      await p.text({
        message: 'Region',
        initialValue: provider.region,
        validate: (value) => (value?.trim() ? undefined : 'Required.'),
      }),
    )
  }

  if (!form.accessKeyId || !form.secretAccessKey) {
    p.log.info(`Keys are created in the provider's console: ${notes.keysAt}`)
  }
  if (!form.accessKeyId) {
    form.accessKeyId = answer(
      await p.text({
        message: provider.accessKeyLabel,
        validate: (value) => (value?.trim() ? undefined : 'Required.'),
      }),
    )
  }
  if (!form.secretAccessKey) {
    form.secretAccessKey = answer(
      await p.password({
        message: provider.secretKeyLabel,
        validate: (value) => (value?.trim() ? undefined : 'Required.'),
      }),
    )
  }

  if (!form.bucket) {
    form.bucket = answer(
      await p.text({
        message:
          provider.bucketNamespace === 'global'
            ? 'Bucket name (shared namespace, so a random one is suggested)'
            : 'Bucket name',
        initialValue: suggestBucketName(),
        validate: (value) =>
          BUCKET_RE.test((value ?? '').trim())
            ? undefined
            : 'Lowercase letters, numbers, dots and hyphens; 3–63 characters.',
      }),
    )
  }
  if (options.given.prefix === undefined) {
    form.prefix =
      answer(
        await p.text({
          message: 'Prefix inside the bucket (optional)',
          placeholder: 'chats',
          defaultValue: '',
        }),
      ) ?? ''
  }

  const invalid = validateS3Form(form)
  if (Object.keys(invalid).length > 0) {
    for (const [field, message] of Object.entries(invalid)) {
      p.log.error(`${field}: ${message}`)
    }
    p.outro('Nothing was changed.')
    return 2
  }
  const config = normalizeS3Config(form)

  for (const caution of endpointCautions(config.endpoint)) {
    p.log.warn(`Passes here, but matters in the app: ${caution}`)
  }

  p.log.step(`Setting up ${config.bucket} at ${config.endpoint}`)
  const outcome = await runBucketSetup(
    { config, providerId, origins: options.origins },
    { onStep: renderStep },
  )

  if (!outcome.ok) {
    p.outro(`Not connected. ${RERUN}`)
    return 1
  }

  const handoff = composeHandoff(config, providerId, options.appUrl)
  printHandoff(handoff, (line) => process.stdout.write(line))
  if (options.qr) {
    const qr = await QRCode.toString(handoff.link, {
      type: 'terminal',
      small: true,
      errorCorrectionLevel: 'L',
    })
    p.log.message(qr)
  }
  p.outro('Done.')
  return 0
}

function renderStep(step: StepResult): void {
  const title = STEP_TITLES[step.id]
  if (step.probe) p.log.message(probeLines(step.probe).join('\n'))
  switch (step.status) {
    case 'skip':
      return
    case 'ok':
      p.log.success(`${title}: ${step.detail}`)
      return
    case 'warn':
      p.log.warn(`${title}: ${step.detail}${step.fix ? ` ${step.fix}` : ''}`)
      return
    case 'fail':
      p.log.error(`${title}: ${step.detail}${step.fix ? `\n${step.fix}` : ''}`)
      return
  }
}

/** OSC 8 terminal hyperlink. Terminals without support show the label alone. */
function hyperlink(url: string, label: string): string {
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`
}

/**
 * The link and the string are written as raw lines, never through a clack
 * box: the box hard-wraps at terminal width, which stops link detection at
 * the first row and puts gutter characters into a copied string. A raw line
 * soft-wraps, so both survive click and copy.
 */
export function printHandoff(
  handoff: { link: string; connectionString: string },
  write: (line: string) => void,
  tty = process.stdout.isTTY === true,
): void {
  const gutter = '│  '
  write(`${gutter}Open this on this device to connect:\n`)
  write(
    `${gutter}${tty ? hyperlink(handoff.link, handoff.link) : handoff.link}\n`,
  )
  write(`${gutter}\n`)
  write(`${gutter}Or paste this into the app on any device:\n`)
  write(`${gutter}${handoff.connectionString}\n`)
  write(`${gutter}\n`)
  write(`${gutter}${BEARER_LINE}\n`)
  write(`${gutter}\n`)
}

/** One line per probe step: the failed one and everything after it did not run. */
export function probeLines(test: S3ConnectionTest): string[] {
  const failedAt = test.ok
    ? PROBE_ORDER.length
    : PROBE_ORDER.indexOf(test.failedStep ?? 'list')
  return PROBE_ORDER.map((step, index) => {
    const mark = index < failedAt ? '✓' : index === failedAt ? '✗' : '–'
    return `  ${mark} ${PROBE_LABELS[step]}`
  })
}

/** Executed as a program, rather than imported for its helpers? Resolves the npm bin symlink. */
function isMain(): boolean {
  try {
    return (
      process.argv[1] !== undefined &&
      pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
    )
  } catch {
    return false
  }
}

if (isMain()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    },
  )
}
