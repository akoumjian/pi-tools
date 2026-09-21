import { Type, type Static } from "@earendil-works/pi-ai";

export const MAX_WORKER_TASK_IDS = 32;

export const WorkerHandoffStateSchema = Type.Union([
  Type.Literal("ready_for_review"),
  Type.Literal("assignment_complete"),
  Type.Literal("needs_input"),
  Type.Literal("blocked"),
  Type.Literal("checkpoint"),
  Type.Literal("failed"),
  Type.Literal("cancelled")
]);

const WorkerRepositorySchema = Type.Object({
  workspaceRepo: Type.String({ minLength: 1, maxLength: 1024 }),
  purpose: Type.String({ minLength: 1, maxLength: 2000 }),
  dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 16 }))
}, { additionalProperties: false });

const WorkerCheckSchema = Type.Object({
  cwd: Type.String({ minLength: 1, maxLength: 1024 }),
  command: Type.String({ minLength: 1, maxLength: 4000 }),
  outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
  logPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 }))
}, { additionalProperties: false });

export const WorkerHandoffParams = Type.Object({
  state: WorkerHandoffStateSchema,
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  taskUpdates: Type.Array(Type.Object({
    taskId: Type.String({ minLength: 1, maxLength: 128 }),
    update: Type.String({ minLength: 1, maxLength: 4000 })
  }, { additionalProperties: false }), { maxItems: 32 }),
  repositories: Type.Optional(Type.Array(WorkerRepositorySchema, { maxItems: 16 })),
  checks: Type.Optional(Type.Array(WorkerCheckSchema, { maxItems: 32 })),
  question: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 }))
}, { additionalProperties: false });

export type WorkerHandoff = Static<typeof WorkerHandoffParams>;

export const AcceptedWorkerHandoffSchema = Type.Object({
  version: Type.Literal(1),
  workerId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  acceptedAt: Type.String({ minLength: 1 }),
  handoff: WorkerHandoffParams
}, { additionalProperties: false });

export type AcceptedWorkerHandoff = Static<typeof AcceptedWorkerHandoffSchema>;
