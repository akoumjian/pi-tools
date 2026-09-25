import { Type, type TSchema } from "@earendil-works/pi-ai";
import { CompletionDeliverySchema } from "./completion-delivery.js";
import { AcceptedWorkerHandoffSchema, MAX_WORKER_TASK_IDS } from "./worker-contract.js";

const NonNegativeIntegerSchema = Type.Integer({ minimum: 0 });
const PositiveIntegerSchema = Type.Integer({ minimum: 1 });
const NonNegativeNumberSchema = Type.Number({ minimum: 0 });
const PositiveNumberSchema = Type.Number({ minimum: 1 });
const NullableIntegerSchema = Type.Union([Type.Integer(), Type.Null()]);
const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);

export const TextContentSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String()
}, { additionalProperties: false });

export const ImageContentSchema = Type.Object({
  type: Type.Literal("image"),
  data: Type.String({ minLength: 1 }),
  mimeType: Type.String({ pattern: "^image/" })
}, { additionalProperties: false });

export const EmptyDetailsSchema = Type.Object({}, { additionalProperties: false });

function textResultSchema(details: TSchema, maxItems = 1, minItems = 1): TSchema {
  return Type.Object({
    content: Type.Array(TextContentSchema, { minItems, maxItems }),
    details
  }, { additionalProperties: false });
}

export const RuntimeErrorResultSchema = textResultSchema(EmptyDetailsSchema);

function finalResultSchema(details: TSchema, maxContentItems = 1): TSchema {
  return Type.Union([
    textResultSchema(details, maxContentItems),
    RuntimeErrorResultSchema
  ]);
}

const OutputBytesSchema = Type.Object({
  stdout: NonNegativeIntegerSchema,
  stderr: NonNegativeIntegerSchema
}, { additionalProperties: false });

const JobStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("exited"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("unknown")
]);

const JobStartSchema = Type.Object({
  jobId: Type.String({ minLength: 1 }),
  job_name: Type.Optional(Type.String({ minLength: 1 })),
  command: Type.String(),
  cwd: Type.String({ minLength: 1 }),
  status: JobStatusSchema,
  durationMs: Type.Optional(NonNegativeNumberSchema),
  exitCode: Type.Optional(NullableIntegerSchema),
  signal: Type.Optional(NullableStringSchema),
  error: Type.Optional(Type.String()),
  stdoutLog: Type.String({ minLength: 1 }),
  stderrLog: Type.String({ minLength: 1 }),
  outputBytes: OutputBytesSchema
}, { additionalProperties: false });

const AsyncShellJobOwnerSchema = Type.Object({
  kind: Type.Literal("worker-run"),
  workerId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 })
}, { additionalProperties: false });

const JobMetaSchema = Type.Object({
  jobId: Type.String({ minLength: 1 }),
  job_name: Type.Optional(Type.String({ minLength: 1 })),
  command: Type.String(),
  cwd: Type.String({ minLength: 1 }),
  shell: Type.String({ minLength: 1 }),
  status: JobStatusSchema,
  pid: Type.Optional(PositiveIntegerSchema),
  startedAt: Type.String({ minLength: 1 }),
  endedAt: Type.Optional(Type.String({ minLength: 1 })),
  durationMs: Type.Optional(NonNegativeNumberSchema),
  exitCode: Type.Optional(NullableIntegerSchema),
  signal: Type.Optional(NullableStringSchema),
  error: Type.Optional(Type.String()),
  notifyOnExit: Type.Boolean(),
  completionNotified: Type.Boolean(),
  owner: Type.Optional(AsyncShellJobOwnerSchema),
  processToken: Type.Optional(Type.String({ minLength: 1 })),
  logDir: Type.String({ minLength: 1 }),
  stdoutLog: Type.String({ minLength: 1 }),
  stderrLog: Type.String({ minLength: 1 }),
  outputBytes: OutputBytesSchema
}, { additionalProperties: false });

const JobOutputSchema = Type.Object({
  stdout: Type.String(),
  stderr: Type.String()
}, { additionalProperties: false });

const ShellTruncationSchema = Type.Object({
  truncated: Type.Boolean(),
  truncatedBy: Type.Union([Type.Literal("lines"), Type.Null()]),
  totalLines: NonNegativeIntegerSchema,
  outputLines: NonNegativeIntegerSchema,
  totalBytes: NonNegativeIntegerSchema,
  outputBytes: NonNegativeIntegerSchema,
  nextOffset: Type.Optional(PositiveNumberSchema)
}, { additionalProperties: false });

const ShellTailStreamSchema = Type.Object({
  stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
  logPath: Type.String({ minLength: 1 }),
  mode: Type.Literal("tail"),
  requestedLines: Type.Number({ minimum: 1, maximum: 500 }),
  requestedMaxChars: Type.Number({ minimum: 1000, maximum: 120000 }),
  previewLines: Type.Array(Type.String(), { maxItems: 2 })
}, { additionalProperties: false });

const ShellRangeStreamSchema = Type.Object({
  stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
  logPath: Type.String({ minLength: 1 }),
  mode: Type.Literal("range"),
  offset: PositiveNumberSchema,
  requestedLimit: Type.Optional(PositiveNumberSchema),
  truncation: ShellTruncationSchema,
  previewLines: Type.Array(Type.String(), { maxItems: 2 })
}, { additionalProperties: false });

const ShellStartDetailsSchema = Type.Object({
  jobs: Type.Array(JobStartSchema, { minItems: 1, maxItems: 12 })
}, { additionalProperties: false });

const ShellStatusDetailsSchema = Type.Union([
  Type.Object({
    job: JobMetaSchema,
    output: JobOutputSchema
  }, { additionalProperties: false }),
  Type.Object({
    jobs: Type.Array(JobMetaSchema, { maxItems: 100 })
  }, { additionalProperties: false })
]);

const ShellReadDetailsSchema = Type.Union([
  Type.Object({
    job: JobMetaSchema,
    streams: Type.Array(ShellTailStreamSchema, { minItems: 1, maxItems: 2 })
  }, { additionalProperties: false }),
  Type.Object({
    job: JobMetaSchema,
    streams: Type.Array(ShellRangeStreamSchema, { minItems: 1, maxItems: 2 })
  }, { additionalProperties: false })
]);

const ShellCancelDetailsSchema = Type.Object({
  job: JobMetaSchema,
  output: JobOutputSchema
}, { additionalProperties: false });

const ReadLineContinuationSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  offset: PositiveIntegerSchema,
  limit: Type.Optional(PositiveIntegerSchema)
}, { additionalProperties: false });

const ReadCursorContinuationSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  cursor: Type.String({ minLength: 1 })
}, { additionalProperties: false });

const ReadTruncationMetrics = {
  totalLines: NonNegativeIntegerSchema,
  outputLines: NonNegativeIntegerSchema,
  totalBytes: NonNegativeIntegerSchema,
  outputBytes: NonNegativeIntegerSchema
};

const CompleteLineReadTruncationSchema = Type.Object({
  truncated: Type.Literal(false),
  truncatedBy: Type.Null(),
  ...ReadTruncationMetrics,
  partialLine: Type.Literal(false)
}, { additionalProperties: false });

const ContinuedLineReadTruncationSchema = Type.Object({
  truncated: Type.Literal(true),
  truncatedBy: Type.Union([Type.Literal("lines"), Type.Literal("bytes")]),
  ...ReadTruncationMetrics,
  partialLine: Type.Literal(false),
  continuation: ReadLineContinuationSchema
}, { additionalProperties: false });

const CompleteByteReadTruncationSchema = Type.Object({
  truncated: Type.Literal(false),
  truncatedBy: Type.Null(),
  ...ReadTruncationMetrics,
  partialLine: Type.Literal(true)
}, { additionalProperties: false });

const CursorContinuedByteReadTruncationSchema = Type.Object({
  truncated: Type.Literal(true),
  truncatedBy: Type.Literal("bytes"),
  ...ReadTruncationMetrics,
  partialLine: Type.Literal(true),
  continuation: ReadCursorContinuationSchema
}, { additionalProperties: false });

const LineContinuedByteReadTruncationSchema = Type.Object({
  truncated: Type.Literal(true),
  truncatedBy: Type.Literal("lines"),
  ...ReadTruncationMetrics,
  partialLine: Type.Literal(true),
  continuation: ReadLineContinuationSchema
}, { additionalProperties: false });

const ReadFileBaseProperties = {
  path: Type.String({ minLength: 1 }),
  resolvedPath: Type.String({ minLength: 1 }),
  previewLines: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 2 })
};

const ReadLineTextFileDetailsSchema = Type.Object({
  ...ReadFileBaseProperties,
  kind: Type.Literal("text"),
  mode: Type.Literal("lines"),
  offset: PositiveIntegerSchema,
  requestedLimit: Type.Optional(PositiveIntegerSchema),
  truncation: Type.Union([CompleteLineReadTruncationSchema, ContinuedLineReadTruncationSchema])
}, { additionalProperties: false });

const ReadByteTextFileDetailsSchema = Type.Object({
  ...ReadFileBaseProperties,
  kind: Type.Literal("text"),
  mode: Type.Literal("bytes"),
  byteStart: NonNegativeIntegerSchema,
  byteEndExclusive: NonNegativeIntegerSchema,
  truncation: Type.Union([
    CompleteByteReadTruncationSchema,
    CursorContinuedByteReadTruncationSchema,
    LineContinuedByteReadTruncationSchema
  ])
}, { additionalProperties: false });

const ReadTextFileDetailsSchema = Type.Union([ReadLineTextFileDetailsSchema, ReadByteTextFileDetailsSchema]);

const ReadImageFileDetailsSchema = Type.Object({
  ...ReadFileBaseProperties,
  kind: Type.Literal("image"),
  inputMimeType: Type.Union([
    Type.Literal("image/jpeg"),
    Type.Literal("image/png"),
    Type.Literal("image/gif"),
    Type.Literal("image/webp"),
    Type.Literal("image/bmp")
  ]),
  mimeType: Type.String({ pattern: "^image/" }),
  originalBytes: NonNegativeIntegerSchema,
  attachmentCount: Type.Literal(1)
}, { additionalProperties: false });

const ReadFileDetailsSchema = Type.Union([ReadTextFileDetailsSchema, ReadImageFileDetailsSchema]);

const ReadManyDetailsSchema = Type.Object({
  files: Type.Array(ReadFileDetailsSchema, { minItems: 1, maxItems: 24 })
}, { additionalProperties: false });

const ReadManyContentSchema = Type.Unsafe({
  type: "array",
  prefixItems: [TextContentSchema],
  items: ImageContentSchema,
  minItems: 1,
  maxItems: 21
});

const ReadManyResultSchema = Type.Union([
  Type.Object({
    content: ReadManyContentSchema,
    details: ReadManyDetailsSchema
  }, { additionalProperties: false }),
  RuntimeErrorResultSchema
]);

const SearchResultDetailsSchema = Type.Object({
  kind: Type.Union([Type.Literal("content"), Type.Literal("files")]),
  path: Type.String({ minLength: 1 }),
  resolvedPath: Type.String({ minLength: 1 }),
  pattern: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),
  context: Type.Number({ minimum: 0, maximum: 10 }),
  maxResults: Type.Number({ minimum: 1, maximum: 1000 }),
  outputLines: NonNegativeIntegerSchema,
  truncated: Type.Boolean(),
  exitCode: NullableIntegerSchema,
  signal: Type.Optional(NullableStringSchema),
  previewLines: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 3 })
}, { additionalProperties: false });

const SearchManyDetailsSchema = Type.Object({
  searches: Type.Array(SearchResultDetailsSchema, { minItems: 1, maxItems: 24 })
}, { additionalProperties: false });

const MutationKindSchema = Type.Union([
  Type.Literal("create"),
  Type.Literal("overwrite"),
  Type.Literal("replace")
]);

const MutationReviewDetailsSchema = Type.Object({
  pendingId: Type.String({ minLength: 1 }),
  blocked: Type.Array(Type.Object({
    id: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    kind: MutationKindSchema
  }, { additionalProperties: false }), { minItems: 1, maxItems: 24 }),
  summary: Type.String()
}, { additionalProperties: false });

const WriteFileDetailsSchema = Type.Object({
  id: Type.String({ pattern: "^m_[a-f0-9]{12}$" }),
  scopedId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.String({ minLength: 1 }),
  resolvedPath: Type.String({ minLength: 1 }),
  bytes: NonNegativeIntegerSchema,
  lines: PositiveIntegerSchema
}, { additionalProperties: false });

const WriteManyDetailsSchema = Type.Object({
  files: Type.Array(WriteFileDetailsSchema, { minItems: 1, maxItems: 24 }),
  mutationReview: Type.Optional(MutationReviewDetailsSchema)
}, { additionalProperties: false });

const MutationReviewOnlyDetailsSchema = Type.Object({
  mutationReview: MutationReviewDetailsSchema
}, { additionalProperties: false });

function mutationResultSchema(details: TSchema): TSchema {
  return Type.Union([
    textResultSchema(details, 2),
    textResultSchema(MutationReviewOnlyDetailsSchema, 2, 2),
    RuntimeErrorResultSchema
  ]);
}

const LineRangeSchema = Type.Object({
  startLine: PositiveIntegerSchema,
  endLine: PositiveIntegerSchema
}, { additionalProperties: false });

const EditFileDetailsSchema = Type.Object({
  id: Type.String({ pattern: "^m_[a-f0-9]{12}$" }),
  scopedId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.String({ minLength: 1 }),
  resolvedPath: Type.String({ minLength: 1 }),
  replacements: PositiveIntegerSchema,
  ranges: Type.Array(LineRangeSchema, { minItems: 1, maxItems: 50 }),
  bytesBefore: NonNegativeIntegerSchema,
  bytesAfter: NonNegativeIntegerSchema
}, { additionalProperties: false });

const EditManyDetailsSchema = Type.Object({
  files: Type.Array(EditFileDetailsSchema, { minItems: 1, maxItems: 24 }),
  mutationReview: Type.Optional(MutationReviewDetailsSchema)
}, { additionalProperties: false });

const AppliedMutationFileSchema = Type.Object({
  id: Type.String({ pattern: "^m_[a-f0-9]{12}$" }),
  path: Type.String({ minLength: 1 }),
  resolvedPath: Type.String({ minLength: 1 }),
  kind: MutationKindSchema,
  bytes: NonNegativeIntegerSchema,
  lines: PositiveIntegerSchema,
  beforeHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  afterHash: Type.String({ pattern: "^[a-f0-9]{64}$" })
}, { additionalProperties: false });

const ApplyReviewedMutationDetailsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  fingerprint: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  toolCallId: Type.String({ minLength: 1 }),
  files: Type.Array(AppliedMutationFileSchema, { minItems: 1, maxItems: 24 })
}, { additionalProperties: false });

const SearxngSearchDetailsSchema = Type.Object({
  query: Type.String(),
  resultCount: Type.Integer({ minimum: 0, maximum: 20 }),
  page: PositiveNumberSchema,
  baseUrl: Type.String({ minLength: 1 }),
  unresponsiveEngines: Type.Optional(Type.Array(Type.String()))
}, { additionalProperties: false });

const DocumentParseHintSchema = Type.Object({
  tool: Type.Literal("document_parse"),
  path: Type.String({ minLength: 1 }),
  reason: Type.String()
}, { additionalProperties: false });

const WebFetchResultSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
  label: Type.Optional(Type.String()),
  finalUrl: Type.Optional(Type.String({ minLength: 1 })),
  fetchedAt: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
  kind: Type.Optional(Type.Union([Type.Literal("html"), Type.Literal("text"), Type.Literal("download")])),
  httpStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
  contentType: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  bytes: Type.Optional(NonNegativeIntegerSchema),
  sourcePath: Type.Optional(Type.String({ minLength: 1 })),
  textPath: Type.Optional(Type.String({ minLength: 1 })),
  downloadedPath: Type.Optional(Type.String({ minLength: 1 })),
  documentParseHint: Type.Optional(DocumentParseHintSchema),
  preview: Type.Optional(Type.String()),
  truncated: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.String())
}, { additionalProperties: false });

const WebFetchManyDetailsSchema = Type.Object({
  cacheRoot: Type.String({ minLength: 1 }),
  results: Type.Array(WebFetchResultSchema, { minItems: 1, maxItems: 12 })
}, { additionalProperties: false });

const DocumentParseDetailsSchema = Type.Object({
  sourcePath: Type.String({ minLength: 1 }),
  resolvedPath: Type.String({ minLength: 1 }),
  outputFormat: Type.Union([Type.Literal("text"), Type.Literal("json")]),
  outputPath: Type.String({ minLength: 1 }),
  outputDir: Type.String({ minLength: 1 }),
  pageCount: NonNegativeIntegerSchema,
  screenshotCount: NonNegativeIntegerSchema,
  screenshotDir: Type.Optional(Type.String({ minLength: 1 })),
  screenshotPathsPreview: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 })),
  warnings: Type.Optional(Type.Array(Type.String()))
}, { additionalProperties: false });

const WorkerCacheLineageSummarySchema = Type.Object({
  mode: Type.Union([
    Type.Literal("eligible"),
    Type.Literal("adopted"),
    Type.Literal("fresh"),
    Type.Literal("retired"),
    Type.Literal("failed"),
    Type.Literal("unavailable")
  ]),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 }))
}, { additionalProperties: false });

const WorkerRunReceiptSchema = Type.Object({
  workerId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  jobId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  sessionFile: Type.Optional(Type.String({ minLength: 1 })),
  workspaceRoot: Type.String({ minLength: 1 }),
  taskIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_WORKER_TASK_IDS }),
  provider: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  thinkingLevel: Type.String({ minLength: 1 }),
  completionDelivery: CompletionDeliverySchema,
  state: Type.Union([Type.Literal("queued"), Type.Literal("running")]),
  cacheLineage: Type.Optional(WorkerCacheLineageSummarySchema)
}, { additionalProperties: false });

const WorkerRunDetailsSchema = Type.Object({
  runs: Type.Array(WorkerRunReceiptSchema, { minItems: 1, maxItems: 8 })
}, { additionalProperties: false });

const WorkerReviewAttemptSchema = Type.Object({
  route: Type.String({ minLength: 1, maxLength: 512 }),
  outcome: Type.Union([Type.Literal("completed"), Type.Literal("rate_limited")])
}, { additionalProperties: false });

const WorkerReviewDetailsSchema = Type.Object({
  workerId: Type.String({ minLength: 1, maxLength: 128 }),
  runId: Type.String({ minLength: 1, maxLength: 128 }),
  candidateId: Type.String({ pattern: "^candidate_[0-9a-f]{24}$" }),
  workspaceRepo: Type.String({ minLength: 1, maxLength: 1024 }),
  headCommit: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
  headTree: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
  model: Type.String({ minLength: 1, maxLength: 512 }),
  thinkingLevel: Type.String({ minLength: 1, maxLength: 16 }),
  startedAt: Type.String({ minLength: 1, maxLength: 64 }),
  completedAt: Type.String({ minLength: 1, maxLength: 64 }),
  durationMs: NonNegativeNumberSchema,
  toolCallCount: NonNegativeIntegerSchema,
  attempts: Type.Array(WorkerReviewAttemptSchema, { minItems: 1, maxItems: 2 }),
  verdict: Type.Union([Type.Literal("approve"), Type.Literal("request_changes"), Type.Literal("blocked")]),
  findings: Type.String({ minLength: 1, maxLength: 24000 }),
  checks: Type.String({ minLength: 1, maxLength: 8000 })
}, { additionalProperties: false });

const WorkerFoldResolveDetailsSchema = Type.Object({
  workerId: Type.String({ minLength: 1 }), runId: Type.String({ minLength: 1 }), jobId: Type.String({ minLength: 1 }), sessionId: Type.String({ minLength: 1 }),
  sessionFile: Type.Optional(Type.String({ minLength: 1 })), workspaceRoot: Type.String({ minLength: 1 }), taskIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_WORKER_TASK_IDS }),
  provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }), thinkingLevel: Type.String({ minLength: 1 }), completionDelivery: CompletionDeliverySchema,
  state: Type.Union([Type.Literal("queued"), Type.Literal("running")]), cacheLineage: Type.Optional(WorkerCacheLineageSummarySchema), phase: Type.Union([Type.Literal("analysis"), Type.Literal("resolution")]), method: Type.Union([Type.Literal("merge"), Type.Literal("squash")]),
  preparedId: Type.String({ pattern: "^prepared_[0-9a-f]{24}$" }), manifestSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }), candidateId: Type.String({ pattern: "^candidate_[0-9a-f]{24}$" }),
  contextSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }), decisionsSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" }))
}, { additionalProperties: false });

const WorkerStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("handed_off"),
  Type.Literal("failed"),
  Type.Literal("cancelled")
]);

const WorkerRouteSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  thinkingLevel: Type.String({ minLength: 1 })
}, { additionalProperties: false });

const RepositoryIntegrationLineageSchema = Type.Object({
  kind: Type.Literal("integration_resolution"),
  preparedId: Type.String({ pattern: "^prepared_[0-9a-f]{24}$" }),
  manifestSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  sourceCandidateIds: Type.Array(Type.String({ pattern: "^candidate_[0-9a-f]{24}$" }), { minItems: 1, maxItems: 16 }),
  contextSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  decisionsSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  analysisRunId: Type.String({ minLength: 1 }),
  resolutionWorkerId: Type.String({ minLength: 1 }),
  resolutionRunId: Type.String({ minLength: 1 }),
  workspaceRepo: Type.String({ minLength: 1, maxLength: 1024 }),
  targetExpectedCommit: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
  targetExpectedTree: Type.String({ pattern: "^[0-9a-f]{40,64}$" })
}, { additionalProperties: false });

const WorkerIntegrationSummarySchema = Type.Object({
  phase: Type.Union([Type.Literal("analysis"), Type.Literal("resolution")]),
  method: Type.Union([Type.Literal("merge"), Type.Literal("squash")]),
  preparedId: Type.String({ pattern: "^prepared_[0-9a-f]{24}$" }),
  manifestSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  candidateId: Type.String({ pattern: "^candidate_[0-9a-f]{24}$" }),
  sourceCandidateIds: Type.Array(Type.String({ pattern: "^candidate_[0-9a-f]{24}$" }), { minItems: 1, maxItems: 16 }),
  workspaceRepo: Type.String({ minLength: 1, maxLength: 1024 }),
  targetRepo: Type.String({ minLength: 1 }),
  targetRef: Type.String({ minLength: 1 }),
  targetExpectedCommit: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
  candidateHeadCommit: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
  contextSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  analysisRunId: Type.String({ minLength: 1 }),
  decisionsSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  resolutionRunId: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });

const RepositoryPolicyIssuesSchema = Type.Array(Type.String({ maxLength: 160 }), { maxItems: 64 });

const RepositoryCandidateSummarySchema = Type.Object({
  candidateId: Type.String({ pattern: "^candidate_[0-9a-f]{24}$" }),
  workspaceRepo: Type.String({ minLength: 1, maxLength: 1024 }),
  reported: Type.Boolean(),
  dirty: Type.Boolean(),
  committedChanged: Type.Boolean(),
  foldable: Type.Boolean(),
  policyIssues: RepositoryPolicyIssuesSchema,
  lineage: Type.Optional(RepositoryIntegrationLineageSchema)
}, { additionalProperties: false });

const ReportedRepositoryIssueSchema = Type.Object({
  kind: Type.Union([Type.Literal("reported_missing"), Type.Literal("reported_not_repository")]),
  workspaceRepo: Type.String({ minLength: 1, maxLength: 1024 })
}, { additionalProperties: false });

const RepositoryScanLimitationSchema = Type.Union([
  Type.Literal("entry_limit"),
  Type.Literal("repository_limit"),
  Type.Literal("depth_limit"),
  Type.Literal("path_limit"),
  Type.Literal("unreadable_directory")
]);

const RepositoryScanCoverageSchema = Type.Object({
  complete: Type.Boolean(),
  limitations: Type.Array(RepositoryScanLimitationSchema, { maxItems: 5 })
}, { additionalProperties: false });

const RepositoryInventorySummarySchema = Type.Object({
  inventoryFile: Type.String({ minLength: 1 }),
  inventorySha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  candidateCount: Type.Integer({ minimum: 0, maximum: 32 }),
  foldableCount: Type.Integer({ minimum: 0, maximum: 32 }),
  reportedIssueCount: Type.Integer({ minimum: 0, maximum: 16 }),
  candidates: Type.Array(RepositoryCandidateSummarySchema, { maxItems: 32 }),
  reportedIssues: Type.Array(ReportedRepositoryIssueSchema, { maxItems: 16 }),
  scanCoverage: RepositoryScanCoverageSchema
}, { additionalProperties: false });

const RepositoryCandidateSchema = Type.Object({
  candidateId: Type.String({ pattern: "^candidate_[0-9a-f]{24}$" }),
  workerId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  workspaceRepo: Type.String({ minLength: 1, maxLength: 1024 }),
  reported: Type.Boolean(),
  purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  dependsOn: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 16 }),
  source: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  baseCommit: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40,64}$" })),
  baseTree: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40,64}$" })),
  headCommit: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40,64}$" })),
  headTree: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40,64}$" })),
  dirty: Type.Boolean(),
  committedChanged: Type.Boolean(),
  foldable: Type.Boolean(),
  policyIssues: RepositoryPolicyIssuesSchema,
  lineage: Type.Optional(RepositoryIntegrationLineageSchema)
}, { additionalProperties: false });

const RepositoryInventorySchema = Type.Object({
  version: Type.Literal(2),
  workerId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  workspaceRoot: Type.String({ minLength: 1 }),
  generatedAt: Type.String({ minLength: 1 }),
  candidates: Type.Array(RepositoryCandidateSchema, { maxItems: 32 }),
  reportedIssues: Type.Array(ReportedRepositoryIssueSchema, { maxItems: 16 }),
  scanCoverage: RepositoryScanCoverageSchema
}, { additionalProperties: false });

const WorkerControlSummarySchema = Type.Object({
  workerId: Type.String({ minLength: 1 }),
  status: WorkerStatusSchema,
  sessionId: Type.String({ minLength: 1 }),
  sessionFile: Type.Optional(Type.String({ minLength: 1 })),
  workspaceRoot: Type.String({ minLength: 1 }),
  taskIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_WORKER_TASK_IDS }),
  route: WorkerRouteSchema,
  cacheLineage: Type.Optional(WorkerCacheLineageSummarySchema),
  integration: Type.Optional(WorkerIntegrationSummarySchema),
  container: Type.Optional(Type.Object({
    name: Type.String({ minLength: 1 }),
    containerId: Type.Optional(Type.String({ minLength: 1 })),
    runId: Type.String({ minLength: 1 })
  }, { additionalProperties: false })),
  activeRun: Type.Optional(Type.Object({
    runId: Type.String({ minLength: 1 }),
    jobId: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("queued"), Type.Literal("running")]),
    completionDelivery: CompletionDeliverySchema,
    recoveryError: Type.Optional(Type.String()),
    stdoutLog: Type.Optional(Type.String({ minLength: 1 })),
    stderrLog: Type.Optional(Type.String({ minLength: 1 }))
  }, { additionalProperties: false })),
  lastRun: Type.Optional(Type.Object({
    runId: Type.String({ minLength: 1 }),
    jobId: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("handed_off"), Type.Literal("failed"), Type.Literal("cancelled")]),
    delivery: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("delivered")])),
    completionDelivery: CompletionDeliverySchema,
    resultFile: Type.Optional(Type.String({ minLength: 1 })),
    stdoutLog: Type.Optional(Type.String({ minLength: 1 })),
    stderrLog: Type.Optional(Type.String({ minLength: 1 })),
    error: Type.Optional(Type.String()),
    repositoryInventory: Type.Optional(RepositoryInventorySummarySchema),
    repositoryError: Type.Optional(Type.String({ maxLength: 512 }))
  }, { additionalProperties: false })),
  updatedAt: Type.String({ minLength: 1 })
}, { additionalProperties: false });

const WorkerControlDetailsSchema = Type.Union([
  Type.Object({
    action: Type.Literal("status"),
    workers: Type.Array(WorkerControlSummarySchema, { maxItems: 100 })
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("result"),
    workerId: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
    jobId: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("handed_off"), Type.Literal("failed"), Type.Literal("cancelled")]),
    delivery: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("delivered")])),
    completionDelivery: CompletionDeliverySchema,
    sessionId: Type.String({ minLength: 1 }),
    workspaceRoot: Type.String({ minLength: 1 }),
    taskIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_WORKER_TASK_IDS }),
    route: WorkerRouteSchema,
    cacheLineage: Type.Optional(WorkerCacheLineageSummarySchema),
    integration: Type.Optional(WorkerIntegrationSummarySchema),
    resultFile: Type.Optional(Type.String({ minLength: 1 })),
    stdoutLog: Type.Optional(Type.String({ minLength: 1 })),
    stderrLog: Type.Optional(Type.String({ minLength: 1 })),
    error: Type.Optional(Type.String()),
    handoff: Type.Optional(AcceptedWorkerHandoffSchema),
    repositories: Type.Optional(RepositoryInventorySchema),
    repositoryError: Type.Optional(Type.String({ maxLength: 512 })),
    acknowledgedDelivery: Type.Boolean()
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("cancel"),
    workerId: Type.String({ minLength: 1 }),
    outcome: Type.Union([Type.Literal("cancelled"), Type.Literal("not_active")]),
    status: WorkerStatusSchema,
    runId: Type.Optional(Type.String({ minLength: 1 })),
    jobId: Type.Optional(Type.String({ minLength: 1 }))
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("discard"),
    workerId: Type.String({ minLength: 1 }),
    discarded: Type.Literal(true)
  }, { additionalProperties: false })
]);

const WorkerFoldPreparedRepositorySchema = Type.Object({
  candidateId: Type.String({ minLength: 34, maxLength: 34, pattern: "^candidate_[0-9a-f]{24}$" }),
  targetRepo: Type.String({ minLength: 1, maxLength: 1024 }),
  targetRef: Type.String({ minLength: 12, maxLength: 251, pattern: "^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$" }),
  method: Type.Union([Type.Literal("merge"), Type.Literal("squash")]),
  status: Type.Union([Type.Literal("ready"), Type.Literal("resolution_required")]),
  expectedCommit: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
  desiredCommit: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40,64}$" })),
  artifactFile: Type.String({ minLength: 1, maxLength: 2048 }),
  viewPath: Type.String({ minLength: 1, maxLength: 2048 })
}, { additionalProperties: false });

const WorkerFoldPrepareDetailsSchema = Type.Object({
  preparedId: Type.String({ minLength: 33, maxLength: 33, pattern: "^prepared_[0-9a-f]{24}$" }),
  manifestFile: Type.String({ minLength: 1, maxLength: 2048 }),
  manifestSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  status: Type.Union([Type.Literal("ready"), Type.Literal("resolution_required")]),
  repositoryCount: Type.Integer({ minimum: 1, maximum: 16 }),
  resolutionCaseCount: Type.Integer({ minimum: 0, maximum: 16 }),
  overlapCount: Type.Integer({ minimum: 0, maximum: 16 }),
  repositories: Type.Array(WorkerFoldPreparedRepositorySchema, { minItems: 1, maxItems: 16 })
}, { additionalProperties: false });

export const RetainedToolOutputSchemas = {
  shell_start: finalResultSchema(ShellStartDetailsSchema),
  shell_status: finalResultSchema(ShellStatusDetailsSchema),
  shell_read: finalResultSchema(ShellReadDetailsSchema),
  shell_cancel: finalResultSchema(ShellCancelDetailsSchema),
  read_many: ReadManyResultSchema,
  search_many: finalResultSchema(SearchManyDetailsSchema),
  write_many: mutationResultSchema(WriteManyDetailsSchema),
  edit_many: mutationResultSchema(EditManyDetailsSchema),
  apply_reviewed_mutation: finalResultSchema(ApplyReviewedMutationDetailsSchema),
  searxng_search: finalResultSchema(SearxngSearchDetailsSchema),
  web_fetch_many: finalResultSchema(WebFetchManyDetailsSchema),
  document_parse: finalResultSchema(DocumentParseDetailsSchema),
  worker_run: finalResultSchema(WorkerRunDetailsSchema),
  worker_review: finalResultSchema(WorkerReviewDetailsSchema),
  worker_control: finalResultSchema(WorkerControlDetailsSchema),
  worker_fold_prepare: finalResultSchema(WorkerFoldPrepareDetailsSchema),
  worker_fold_resolve: finalResultSchema(WorkerFoldResolveDetailsSchema)
} satisfies Record<string, TSchema>;

export type RetainedToolName = keyof typeof RetainedToolOutputSchemas;
