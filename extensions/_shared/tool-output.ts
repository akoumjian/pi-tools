import { Type, type TSchema } from "@earendil-works/pi-ai";

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

const TruncationSchema = Type.Object({
  truncated: Type.Boolean(),
  truncatedBy: Type.Union([Type.Literal("lines"), Type.Literal("bytes"), Type.Null()]),
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

const ReadFileDetailsSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  resolvedPath: Type.String({ minLength: 1 }),
  offset: PositiveNumberSchema,
  requestedLimit: Type.Optional(PositiveNumberSchema),
  truncation: TruncationSchema,
  previewLines: Type.Array(Type.String(), { maxItems: 2 })
}, { additionalProperties: false });

const ReadManyDetailsSchema = Type.Object({
  files: Type.Array(ReadFileDetailsSchema, { minItems: 1, maxItems: 24 })
}, { additionalProperties: false });

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
  previewLines: Type.Array(Type.String(), { maxItems: 3 })
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
  baseUrl: Type.String({ minLength: 1 })
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

const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max")
]);

const RouteAttemptSchema = Type.Object({
  model: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("rejected"), Type.Literal("failed"), Type.Literal("completed")]),
  failureKind: Type.Optional(Type.Union([
    Type.Literal("aborted"),
    Type.Literal("auth"),
    Type.Literal("rate_limit"),
    Type.Literal("transient"),
    Type.Literal("other"),
    Type.Literal("reviewer_unavailable")
  ])),
  error: Type.Optional(Type.String())
}, { additionalProperties: false });

const WriterWorktreeSchema = Type.Object({
  branch: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  baseCommit: Type.String({ minLength: 1 }),
  action: Type.Union([Type.Literal("removed"), Type.Literal("kept")])
}, { additionalProperties: false });

const WriterReviewAttemptSchema = Type.Object({
  model: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("rejected"),
    Type.Literal("failed"),
    Type.Literal("unparseable"),
    Type.Literal("approve"),
    Type.Literal("request_changes")
  ]),
  error: Type.Optional(Type.String())
}, { additionalProperties: false });

const WriterReviewSchema = Type.Object({
  status: Type.Union([
    Type.Literal("approve"),
    Type.Literal("request_changes"),
    Type.Literal("unparseable"),
    Type.Literal("failed")
  ]),
  model: Type.Optional(Type.String({ minLength: 1 })),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  output: Type.Optional(Type.String()),
  durationMs: Type.Optional(NonNegativeNumberSchema),
  deniedCalls: Type.Optional(Type.Array(Type.String())),
  attempts: Type.Array(WriterReviewAttemptSchema),
  error: Type.Optional(Type.String())
}, { additionalProperties: false });

const OrchestratedTaskResultSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  role: Type.Union([Type.Literal("reader"), Type.Literal("planner"), Type.Literal("writer")]),
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
  error: Type.Optional(Type.String()),
  output: Type.String(),
  model: Type.String({ minLength: 1 }),
  thinkingLevel: ThinkingLevelSchema,
  toolCallCount: NonNegativeIntegerSchema,
  durationMs: NonNegativeNumberSchema,
  deniedCalls: Type.Array(Type.String()),
  routeAttempts: Type.Array(RouteAttemptSchema),
  worktree: Type.Optional(WriterWorktreeSchema),
  commit: Type.Optional(Type.String({ minLength: 1 })),
  changedFiles: Type.Optional(Type.Array(Type.String())),
  review: Type.Optional(WriterReviewSchema)
}, { additionalProperties: false });

const OrchestrateDetailsSchema = Type.Object({
  mode: Type.Union([Type.Literal("read-only"), Type.Literal("read-write")]),
  configSource: Type.String({ minLength: 1 }),
  results: Type.Array(OrchestratedTaskResultSchema, { maxItems: 8 })
}, { additionalProperties: false });

const ReconcileFoldedSchema = Type.Object({
  branch: Type.String({ minLength: 1 }),
  changedFiles: Type.Array(Type.String())
}, { additionalProperties: false });

const ReconcileSkippedSchema = Type.Object({
  branch: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("conflict"),
    Type.Literal("validation_failed"),
    Type.Literal("merge_failed"),
    Type.Literal("invalid")
  ]),
  reason: Type.String()
}, { additionalProperties: false });

const ReconcileOverlapSchema = Type.Object({
  left: Type.String({ minLength: 1 }),
  right: Type.String({ minLength: 1 }),
  files: Type.Array(Type.String())
}, { additionalProperties: false });

const ReconcileSharedProperties = {
  folded: Type.Array(ReconcileFoldedSchema, { maxItems: 8 }),
  skipped: Type.Array(ReconcileSkippedSchema, { maxItems: 8 }),
  overlaps: Type.Array(ReconcileOverlapSchema),
  validation: Type.Union([Type.Literal("passed-per-fold"), Type.Literal("unvalidated")]),
  cleanedBranches: Type.Array(Type.String(), { maxItems: 8 })
};

const ReconcileDetailsSchema = Type.Union([
  Type.Object({
    status: Type.Literal("merged"),
    integrationBranch: Type.String({ minLength: 1 }),
    integrationPath: Type.String({ minLength: 1 }),
    mergeCommit: Type.String({ minLength: 1 }),
    ...ReconcileSharedProperties
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("declined"),
    integrationBranch: Type.String({ minLength: 1 }),
    integrationPath: Type.String({ minLength: 1 }),
    ...ReconcileSharedProperties
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("nothing_merged"),
    ...ReconcileSharedProperties
  }, { additionalProperties: false })
]);

export const RetainedToolOutputSchemas = {
  shell_start: finalResultSchema(ShellStartDetailsSchema),
  shell_status: finalResultSchema(ShellStatusDetailsSchema),
  shell_read: finalResultSchema(ShellReadDetailsSchema),
  shell_cancel: finalResultSchema(ShellCancelDetailsSchema),
  read_many: finalResultSchema(ReadManyDetailsSchema),
  search_many: finalResultSchema(SearchManyDetailsSchema),
  write_many: mutationResultSchema(WriteManyDetailsSchema),
  edit_many: mutationResultSchema(EditManyDetailsSchema),
  apply_reviewed_mutation: finalResultSchema(ApplyReviewedMutationDetailsSchema),
  searxng_search: finalResultSchema(SearxngSearchDetailsSchema),
  web_fetch_many: finalResultSchema(WebFetchManyDetailsSchema),
  document_parse: finalResultSchema(DocumentParseDetailsSchema),
  orchestrate: finalResultSchema(OrchestrateDetailsSchema),
  reconcile: finalResultSchema(ReconcileDetailsSchema)
} satisfies Record<string, TSchema>;

export type RetainedToolName = keyof typeof RetainedToolOutputSchemas;
