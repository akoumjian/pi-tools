import { Type, type TSchema } from "@earendil-works/pi-ai";
import { CompletionDeliverySchema } from "./completion-delivery.js";

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

const WorkerV2RoleSchema = Type.Union([Type.Literal("work"), Type.Literal("review"), Type.Literal("integration")]);
const WorkerRunV2ReceiptSchema = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("resume")]), role: WorkerV2RoleSchema,
  workerId: Type.String({ minLength: 1 }), runId: Type.String({ minLength: 1 }), status: Type.Union([Type.Literal("queued"), Type.Literal("running")]),
  taskIds: Type.Array(Type.String()), completionDelivery: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
  modelSelection: Type.Optional(Type.String()), reviewedRunId: Type.Optional(Type.String()), preparedId: Type.Optional(Type.String())
}, { additionalProperties: false });
const WorkerRunV2DetailsSchema = Type.Object({ runs: Type.Array(WorkerRunV2ReceiptSchema, { minItems: 1, maxItems: 8 }) }, { additionalProperties: false });
const WorkerOutcomeV2Schema = Type.Union([Type.Literal("completed"),Type.Literal("needs_input"),Type.Literal("blocked"),Type.Literal("approve"),Type.Literal("request_changes"),Type.Literal("failed"),Type.Literal("cancelled")]);
const WorkerOutcomeSourceV2Schema = Type.Union([Type.Literal("worker"),Type.Literal("system")]);
const WorkerListItemV2Schema = Type.Object({ workerId: Type.String(), role: WorkerV2RoleSchema, status: Type.Union([Type.Literal("idle"),Type.Literal("queued"),Type.Literal("running")]), activeRunId: Type.Optional(Type.String()), latestResult: Type.Optional(Type.Object({ runId: Type.String(), outcome: WorkerOutcomeV2Schema, outcomeSource: WorkerOutcomeSourceV2Schema }, { additionalProperties: false })), taskIds: Type.Array(Type.String()), modelSelection: Type.Optional(Type.String()), recoveryRequired: Type.Optional(Type.Literal(true)), lastActivityAt: Type.String() }, { additionalProperties: false });
const WorkerSlimRunV2Schema = Type.Object({ runId: Type.String(), status: Type.Union([Type.Literal("queued"),Type.Literal("running"),Type.Literal("settled")]), outcome: Type.Optional(WorkerOutcomeV2Schema), outcomeSource: Type.Optional(WorkerOutcomeSourceV2Schema), createdAt: Type.String(), startedAt: Type.Optional(Type.String()), settledAt: Type.Optional(Type.String()) }, { additionalProperties: false });
const WorkerRepositoryV2Schema = Type.Object({ repositoryPath: Type.String(), commit: Type.String(), source: Type.Optional(Type.String()), reported: Type.Boolean(), changed: Type.Boolean(), dirty: Type.Boolean(), eligible: Type.Boolean(), issues: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
const WorkerScopedErrorV2Schema = Type.Object({ scope: Type.Union([Type.Literal("run"),Type.Literal("repositories"),Type.Literal("artifacts")]), message: Type.String() }, { additionalProperties: false });
const WorkerGetV2Schema = Type.Object({ workerId: Type.String(), role: WorkerV2RoleSchema, runId: Type.String(), status: Type.Union([Type.Literal("queued"),Type.Literal("running"),Type.Literal("settled")]), taskIds: Type.Array(Type.String()), modelSelection: Type.Optional(Type.String()), createdAt: Type.String(), startedAt: Type.Optional(Type.String()), settledAt: Type.Optional(Type.String()), jobId: Type.String(), stdoutLog: Type.String(), stderrLog: Type.String(), sessionId: Type.Optional(Type.String()), sessionFile: Type.Optional(Type.String()), sessionRange: Type.Object({ startLine: Type.Optional(NonNegativeIntegerSchema), endLine: Type.Optional(NonNegativeIntegerSchema) }, { additionalProperties: false }), workspaceRoot: Type.String(), binding: Type.Optional(Type.Unknown()), recoveryError: Type.Optional(Type.String()), warnings: Type.Optional(Type.Array(Type.String())), outcome: Type.Optional(WorkerOutcomeV2Schema), outcomeSource: Type.Optional(WorkerOutcomeSourceV2Schema), summary: Type.Optional(Type.String()), question: Type.Optional(Type.String()), repositories: Type.Optional(Type.Array(WorkerRepositoryV2Schema)), artifacts: Type.Optional(Type.Array(Type.String())), errors: Type.Optional(Type.Array(WorkerScopedErrorV2Schema)) }, { additionalProperties: false });
const WorkerControlV2DetailsSchema = Type.Union([
  Type.Object({ workers: Type.Array(WorkerListItemV2Schema), total: NonNegativeIntegerSchema, counts: Type.Object({ idle: NonNegativeIntegerSchema, queued: NonNegativeIntegerSchema, running: NonNegativeIntegerSchema }, { additionalProperties: false }), nextOffset: Type.Optional(NonNegativeIntegerSchema) }, { additionalProperties: false }),
  Type.Object({ workerId: Type.String(), runs: Type.Array(WorkerSlimRunV2Schema), total: NonNegativeIntegerSchema, nextOffset: Type.Optional(NonNegativeIntegerSchema) }, { additionalProperties: false }),
  WorkerGetV2Schema,
  Type.Object({ cancellation: Type.Union([Type.Literal("cancelled"),Type.Literal("not_active")]), worker: WorkerListItemV2Schema }, { additionalProperties: false }),
  Type.Object({ workerId: Type.String(), discarded: Type.Literal(true) }, { additionalProperties: false })
]);
const WorkerMergeRepositoryV2Schema = Type.Object({
  id: Type.String(), candidateRepo: Type.String(), candidateCommit: Type.String(), targetRepo: Type.String(), targetRef: Type.String(), method: Type.Union([Type.Literal("merge"), Type.Literal("squash")]),
  status: Type.Union([Type.Literal("ready"), Type.Literal("resolution_required")]), expectedCommit: Type.String(), desiredCommit: Type.Optional(Type.String()), preparedPath: Type.String(), overlapCount: NonNegativeIntegerSchema,
  dependsOn: Type.Array(Type.String()), source: Type.Optional(Type.Object({ workerId: Type.String(), runId: Type.Optional(Type.String()), latest: Type.Boolean() }, { additionalProperties: false })), warnings: Type.Optional(Type.Array(Type.String()))
}, { additionalProperties: false });
const WorkerMergeTestDetailsSchema = Type.Object({ preparedId: Type.String(), status: Type.Union([Type.Literal("ready"), Type.Literal("resolution_required")]), order: Type.Array(Type.String()), repositories: Type.Array(WorkerMergeRepositoryV2Schema), resolutionCases: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: false });
const WorkerMergeApplyDetailsSchema = Type.Object({ preparedId: Type.String(), status: Type.Union([Type.Literal("completed"), Type.Literal("partial"), Type.Literal("failed")]), repositories: Type.Array(Type.Unknown()), error: Type.Optional(Type.String()) }, { additionalProperties: false });

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
  worker_run: finalResultSchema(WorkerRunV2DetailsSchema),
  worker_control: finalResultSchema(WorkerControlV2DetailsSchema),
  worker_merge_test: finalResultSchema(WorkerMergeTestDetailsSchema),
  worker_merge_apply: finalResultSchema(WorkerMergeApplyDetailsSchema)
} satisfies Record<string, TSchema>;


export type RetainedToolName = keyof typeof RetainedToolOutputSchemas;
