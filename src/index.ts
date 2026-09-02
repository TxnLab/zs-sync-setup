export {
  runBucketSetup,
  STEP_TITLES,
  type SetupDeps,
  type SetupInput,
  type SetupOutcome,
  type StepId,
  type StepResult,
  type StepStatus,
} from './bucket-setup.ts'
export { composeHandoff, suggestBucketName, type Handoff } from './handoff.ts'
export {
  corsConfigurationXml,
  corsRule,
  parseCorsConfiguration,
  corsCovers,
} from './cors.ts'
export {
  PROVIDER_NOTES,
  notesFor,
  type ProviderNotes,
  type CreateMissingPolicy,
} from './provider-notes.ts'
export { S3Client, type FetchLike, type S3MirrorConfig } from './s3/client.ts'
export { MirrorIOError, type MirrorErrorKind } from './s3/errors.ts'
export {
  S3_PROVIDERS,
  S3_PROVIDER_CATEGORIES,
  providerById,
  providersInCategory,
  endpointCautions,
  type S3Provider,
  type S3ProviderId,
} from './s3/providers.ts'
export {
  corsPolicyJson,
  normalizeS3Config,
  testS3Connection,
  validateS3Form,
  emptyS3Form,
  applyProvider,
  type S3ConnectionTest,
  type S3FormValues,
  type S3ProbeStep,
} from './s3/setup.ts'
export {
  encodeConnectionString,
  decodeConnectionString,
  connectionDeepLink,
  connectionStringFromFragment,
  type ConnectionStringResult,
} from './s3/connection-string.ts'
