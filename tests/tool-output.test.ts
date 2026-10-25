import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { RetainedToolOutputSchemas, RuntimeErrorResultSchema, type RetainedToolName } from "../extensions/_shared/tool-output.js";

const text = (value: string) => ({ type: "text" as const, text: value });
const outputBytes = { stdout: 0, stderr: 0 };
const jobStart = {
  jobId: "job_1",
  command: "pwd",
  cwd: "/repo",
  status: "exited" as const,
  durationMs: 5,
  exitCode: 0,
  signal: null,
  stdoutLog: "/repo/.pi/jobs/job_1/stdout.log",
  stderrLog: "/repo/.pi/jobs/job_1/stderr.log",
  outputBytes,
  reportedInBand: true
};
const jobMeta = {
  ...jobStart,
  shell: "/bin/zsh",
  pid: 42,
  startedAt: "2026-07-21T00:00:00.000Z",
  endedAt: "2026-07-21T00:00:00.005Z",
  notifyOnExit: true,
  completionNotified: false,
  managedBy: { kind: "worker-host" as const, workerId: "worker_1", runId: "run_1" },
  logDir: "/repo/.pi/jobs/job_1"
};
const truncation = {
  truncated: false,
  truncatedBy: null,
  totalLines: 1,
  outputLines: 1,
  totalBytes: 4,
  outputBytes: 4
};
const readTruncation = {
  ...truncation,
  partialLine: false
};
const mutationReview = {
  pendingId: "mr_01234567",
  blocked: [{ id: "m_0123456789ab", path: "a.ts", kind: "replace" as const }],
  summary: "Reuse the existing helper."
};
const hash = "a".repeat(64);

const samples: Record<RetainedToolName, unknown> = {
  shell_start: {
    content: [text("Async shell job completed.")],
    details: { jobs: [jobStart] }
  },
  shell_status: {
    content: [text("Job status")],
    details: { jobs: [jobMeta] }
  },
  shell_read: {
    content: [text("stdout range")],
    details: {
      job: jobMeta,
      streams: [{
        stream: "stdout",
        logPath: jobMeta.stdoutLog,
        mode: "range",
        offset: 1,
        requestedLimit: 10,
        truncation,
        previewLines: ["line"]
      }]
    }
  },
  shell_cancel: {
    content: [text("Cancellation requested")],
    details: { job: { ...jobMeta, status: "running" }, output: { stdout: "", stderr: "" } }
  },
  read_many: {
    content: [text("file content")],
    details: {
      files: [{
        kind: "text",
        mode: "lines",
        path: "a.ts",
        resolvedPath: "/repo/a.ts",
        offset: 1,
        requestedLimit: 10,
        truncation: readTruncation,
        previewLines: ["const a = 1;"]
      }]
    }
  },
  search_many: {
    content: [text("search result")],
    details: {
      searches: [{
        kind: "content",
        path: ".",
        resolvedPath: "/repo",
        pattern: "needle",
        context: 0,
        maxResults: 100,
        outputLines: 1,
        truncated: false,
        exitCode: 0,
        signal: null,
        previewLines: ["a.ts:1:needle"]
      }]
    }
  },
  write_many: {
    content: [text("Wrote one file"), text("Mutation review skipped one mutation")],
    details: {
      files: [{
        id: "m_abcdef012345",
        path: "a.ts",
        resolvedPath: "/repo/a.ts",
        bytes: 10,
        lines: 1
      }],
      mutationReview
    }
  },
  edit_many: {
    content: [text("Edited one file")],
    details: {
      files: [{
        id: "m_abcdef012345",
        path: "a.ts",
        resolvedPath: "/repo/a.ts",
        replacements: 1,
        ranges: [{ startLine: 1, endLine: 1 }],
        bytesBefore: 10,
        bytesAfter: 11
      }]
    }
  },
  apply_reviewed_mutation: {
    content: [text("Applied reviewed mutation")],
    details: {
      id: "mr_01234567",
      fingerprint: "01234567",
      toolName: "edit_many",
      toolCallId: "call_1",
      files: [{
        id: "m_0123456789ab",
        path: "a.ts",
        resolvedPath: "/repo/a.ts",
        kind: "replace",
        bytes: 11,
        lines: 1,
        beforeHash: hash,
        afterHash: hash
      }]
    }
  },
  searxng_search: {
    content: [text("No SearXNG results")],
    details: { query: "query", resultCount: 0, page: 1, baseUrl: "https://search.example" }
  },
  web_fetch_many: {
    content: [text("Fetched one URL")],
    details: {
      cacheRoot: "/repo/.pi/web-fetch",
      results: [{
        url: "https://example.com",
        finalUrl: "https://example.com/",
        fetchedAt: "2026-07-21T00:00:00.000Z",
        status: "ok",
        kind: "html",
        httpStatus: 200,
        contentType: "text/html",
        bytes: 100,
        sourcePath: "/repo/.pi/web-fetch/source.html",
        textPath: "/repo/.pi/web-fetch/source.md",
        preview: "Example"
      }]
    }
  },
  document_parse: {
    content: [text("Parsed document")],
    details: {
      sourcePath: "report.pdf",
      resolvedPath: "/repo/report.pdf",
      outputFormat: "text",
      outputPath: "/tmp/report/output.txt",
      outputDir: "/tmp/report",
      pageCount: 2,
      screenshotCount: 0
    }
  },
  worker_run: {
    content: [text("queued · work · 12345678")],
    details: { runs: [{ action: "start", role: "work", workerId: "worker_20260910190000_12345678", runId: "run_20260910190000_87654321", status: "queued", taskIds: ["personal-test"], completionDelivery: "steer", modelSelection: "openai-codex/gpt-test:xhigh" }] }
  },
  worker_control: {
    content: [text("1 worker")],
    details: {
      workers: [{
        workerId: "worker_20260910190000_12345678", role: "work", status: "idle",
        latestResult: { runId: "run_20260910190000_87654321", outcome: "completed", outcomeSource: "worker" },
        notification: { state: "send_started_unconfirmed", runId: "run_20260910190000_87654321", runtimeGeneration: 7, sendStartedAt: "2026-09-10T19:00:01.000Z" },
        taskIds: ["personal-test"], modelSelection: "openai-codex/gpt-test:xhigh", lastActivityAt: "2026-09-10T19:00:02.000Z"
      }],
      total: 1, counts: { idle: 1, queued: 0, running: 0 }
    }
  },
  worker_merge_test: {
    content: [text("ready")],
    details: { preparedId: "prepared_aaaaaaaaaaaaaaaaaaaaaaaa", status: "ready", order: ["repo"], repositories: [{ id: "repo", candidateRepo: "/candidate", candidateCommit: "a".repeat(40), targetRepo: "/target", targetRef: "refs/heads/main", method: "merge", status: "ready", expectedCommit: "b".repeat(40), desiredCommit: "c".repeat(40), preparedPath: "/prepared/repo", overlapCount: 0, dependsOn: [] }] }
  },
  worker_merge_apply: {
    content: [text("completed")],
    details: { preparedId: "prepared_aaaaaaaaaaaaaaaaaaaaaaaa", status: "completed", repositories: [] }
  }
};

test("authoritative output schemas accept representative runtime results and generic errors", () => {
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(RetainedToolOutputSchemas).sort());
  for (const [name, schema] of Object.entries(RetainedToolOutputSchemas) as Array<[RetainedToolName, typeof RetainedToolOutputSchemas[RetainedToolName]]>) {
    assert.equal(Check(schema, samples[name]), true, `${name} representative result matches its output schema`);
    assert.equal(Check(schema, { content: [text("Tool failed")], details: {} }), true, `${name} accepts Pi's generic runtime error result`);
    assert.equal(Check(schema, { ...(samples[name] as object), unexpected: true }), false, `${name} rejects unknown top-level fields`);
    assert.equal(Check(schema, { ...(samples[name] as object), isError: true }), false, `${name} rejects raw execute isError`);
  }
  assert.equal(Check(RuntimeErrorResultSchema, { content: [text("Tool failed")], details: {} }), true);
});

test("worker_control publishes strict bounded notification shapes for list and get", () => {
  const list = structuredClone(samples.worker_control) as any;
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, list), true, "list accepts send-started ambiguity visibility");
  assert.equal(list.details.workers[0].notification.state, "send_started_unconfirmed");

  const exactGet = {
    content: [text("settled worker")],
    details: {
      workerId: "worker_20260910190000_12345678", role: "work", runId: "run_20260910190000_87654321", status: "settled",
      taskIds: ["personal-test"], modelSelection: "openai-codex/gpt-test:xhigh", createdAt: "2026-09-10T19:00:00.000Z",
      startedAt: "2026-09-10T19:00:00.500Z", settledAt: "2026-09-10T19:00:01.000Z", jobId: "job_test",
      stdoutLog: "/tmp/stdout.log", stderrLog: "/tmp/stderr.log", sessionRange: { startLine: 1, endLine: 2 }, workspaceRoot: "/workspace",
      outcome: "completed", outcomeSource: "worker",
      notification: { state: "delivered", runId: "run_20260910190000_87654321", runtimeGeneration: 7, deliveredAt: "2026-09-10T19:00:02.000Z" },
      repositories: [], artifacts: [], errors: []
    }
  };
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, exactGet), true, "get accepts exact delivered notification evidence");

  const getBase = {
    workerId: "worker_20260910190000_12345678", role: "work", runId: "run_20260910190000_87654321", taskIds: ["personal-test"],
    modelSelection: "openai-codex/gpt-test:xhigh", createdAt: "2026-09-10T19:00:00.000Z", sessionRange: {}, workspaceRoot: "/workspace"
  };
  const queuedGet = { content: [text("queued")], details: { ...getBase, status: "queued" } };
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, queuedGet), true, "queued pre-launch get may omit host job and log evidence");
  const launchFailedGet = { content: [text("launch failed")], details: { ...getBase, status: "settled", settledAt: "2026-09-10T19:00:01.000Z", outcome: "failed", outcomeSource: "system", repositories: [], artifacts: [], errors: [{ scope: "run", message: "failed before host launch" }] } };
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, launchFailedGet), true, "settled failure before host publication may omit host job and log evidence");
  const runningGet = { content: [text("running")], details: { ...getBase, status: "running", startedAt: "2026-09-10T19:00:00.500Z", jobId: "job_test", stdoutLog: "/tmp/stdout.log", stderrLog: "/tmp/stderr.log" } };
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, runningGet), true, "launched running get requires complete host evidence");
  const malformedQueued: any = structuredClone(queuedGet); malformedQueued.details.hostPid = 123;
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, malformedQueued), false, "queued get rejects unknown lifecycle extras");
  const incompleteRunning: any = structuredClone(runningGet); delete incompleteRunning.details.stderrLog;
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, incompleteRunning), false, "launched running get rejects partial host evidence");
  const launchedSettledWithoutLogs: any = structuredClone(exactGet); delete launchedSettledWithoutLogs.details.stderrLog;
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, launchedSettledWithoutLogs), false, "launched settled get cannot fall back to a pre-launch shape");
  const partialLaunchFailure: any = structuredClone(launchFailedGet); partialLaunchFailure.details.stdoutLog = "/tmp/stdout.log";
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, partialLaunchFailure), false, "pre-launch host evidence is all-or-none");

  const missingBoundary = structuredClone(list); delete missingBoundary.details.workers[0].notification.sendStartedAt;
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, missingBoundary), false, "unconfirmed state requires its persisted send boundary");
  const missingGeneration = structuredClone(list); delete missingGeneration.details.workers[0].notification.runtimeGeneration;
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, missingGeneration), false, "claimed send-started state requires its exact runtime generation");
  const unknownState = structuredClone(list); unknownState.details.workers[0].notification.state = "unknown";
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, unknownState), false, "notification states are closed literals");
  const extraField = structuredClone(list); extraField.details.workers[0].notification.replay = true;
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, extraField), false, "notification shape rejects replay authority");
  const invalidGeneration = structuredClone(list); invalidGeneration.details.workers[0].notification.runtimeGeneration = 0;
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, invalidGeneration), false, "runtime generations are positive integers");
  const wrongDeliveredShape: any = structuredClone(exactGet); wrongDeliveredShape.details.notification.sendStartedAt = "2026-09-10T19:00:01.000Z";
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, wrongDeliveredShape), false, "delivered shape cannot masquerade as send-started ambiguity");
});

test("conditional output variants preserve runtime-only boundaries", () => {
  const partialFailure = {
    content: [text("Tool failed"), text("Mutation review blocked one entry")],
    details: { mutationReview }
  };
  assert.equal(Check(RetainedToolOutputSchemas.write_many, partialFailure), true, "write_many accepts middleware-decorated runtime errors");
  assert.equal(Check(RetainedToolOutputSchemas.edit_many, partialFailure), true, "edit_many accepts middleware-decorated runtime errors");
  assert.equal(Check(RetainedToolOutputSchemas.write_many, { ...partialFailure, content: [text("Tool failed")] }), false, "partial-review-only results require the appended note");

  const shellByteTruncation = structuredClone(samples.shell_read) as { details: { streams: Array<{ truncation: { truncatedBy: string | null } }> } };
  shellByteTruncation.details.streams[0]!.truncation.truncatedBy = "bytes";
  assert.equal(Check(RetainedToolOutputSchemas.shell_read, shellByteTruncation), false, "shell log ranges truncate only by lines");
  const byteContinuedRead = {
    content: [text("partial UTF-8 line")],
    details: {
      files: [{
        kind: "text",
        mode: "bytes",
        path: "large.txt",
        resolvedPath: "/repo/large.txt",
        byteStart: 0,
        byteEndExclusive: 50,
        truncation: {
          truncated: true,
          truncatedBy: "bytes",
          totalLines: 1,
          outputLines: 1,
          totalBytes: 100,
          outputBytes: 50,
          partialLine: true,
          continuation: { path: "large.txt", cursor: "opaque" }
        },
        previewLines: ["partial"]
      }]
    }
  };
  assert.equal(Check(RetainedToolOutputSchemas.read_many, byteContinuedRead), true, "read_many accepts byte-mode cursor continuations");
  const impossibleByteRead = structuredClone(byteContinuedRead) as { details: { files: Array<{ truncation: { partialLine: boolean } }> } };
  impossibleByteRead.details.files[0]!.truncation.partialLine = false;
  assert.equal(Check(RetainedToolOutputSchemas.read_many, impossibleByteRead), false, "byte-mode reads must identify partial-line output");
  assert.equal(Check(RetainedToolOutputSchemas.read_many, {
    content: [text("Read image"), { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    details: {
      files: [{
        kind: "image",
        path: "image.bin",
        resolvedPath: "/repo/image.bin",
        inputMimeType: "image/png",
        mimeType: "image/png",
        originalBytes: 5,
        attachmentCount: 1,
        previewLines: ["Read image file [image/png]"]
      }]
    }
  }), true, "read_many accepts provider-visible image content and image details");
  const imageDetails = {
    files: [{
      kind: "image",
      path: "image.bin",
      resolvedPath: "/repo/image.bin",
      inputMimeType: "image/png",
      mimeType: "image/png",
      originalBytes: 5,
      attachmentCount: 1,
      previewLines: ["Read image file [image/png]"]
    }]
  };
  assert.equal(Check(RetainedToolOutputSchemas.read_many, {
    content: [text("Read image"), { type: "image", data: "", mimeType: "image/png" }],
    details: { files: [] }
  }), false, "read_many rejects empty image payloads and impossible empty details");
  assert.equal(Check(RetainedToolOutputSchemas.read_many, {
    content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    details: imageDetails
  }), false, "read_many requires its one text summary before image attachments");
  assert.equal(Check(RetainedToolOutputSchemas.read_many, {
    content: [text("first"), text("second")],
    details: imageDetails
  }), false, "read_many rejects impossible extra text content blocks");

  assert.equal(Check(RetainedToolOutputSchemas.shell_status, {
    content: [text("Job status")],
    details: { job: jobMeta, output: { stdout: "tail", stderr: "" } }
  }), true, "shell_status accepts its single-job variant");
  assert.equal(Check(RetainedToolOutputSchemas.shell_read, {
    content: [text("stdout tail")],
    details: {
      job: jobMeta,
      streams: [{
        stream: "stdout",
        logPath: jobMeta.stdoutLog,
        mode: "tail",
        requestedLines: 80,
        requestedMaxChars: 20_000,
        previewLines: ["line"]
      }]
    }
  }), true, "shell_read accepts its tail variant without range truncation metadata");

  assert.equal(Check(RetainedToolOutputSchemas.document_parse, {
    content: [text("Parsed document with screenshots")],
    details: {
      sourcePath: "report.pdf",
      resolvedPath: "/repo/report.pdf",
      outputFormat: "json",
      outputPath: "/tmp/report/output.json",
      outputDir: "/tmp/report",
      pageCount: 2,
      screenshotCount: 1,
      screenshotDir: "/tmp/report/screenshots",
      screenshotPathsPreview: ["/tmp/report/screenshots/page-1.png"],
      warnings: ["OCR fallback used"]
    }
  }), true, "document_parse accepts optional screenshot and warning handoffs");
});

test("worker_control cleanup inventory output is strict, bounded, and continuation-aware", () => {
  const value = {
    content: [{ type: "text", text: "1 workers · 1 prepared sets · 1 leftovers" }],
    details: { inventory: {
      workers: [{ workerId: "worker_20261025100002_aaaaaaaa", ownerSession: "/parent.jsonl", owner:{file:"/parent.jsonl",state:"unnamed",id:"parent",label:"parent"}, role: "work", class: "due", reason: "All assigned tasks are closed.",version:1,latestRunId:"run_20261025100002_aaaaaaaa", taskIds: ["personal-test"],taskFacts:[{id:"personal-test",status:"closed"}], unpreservedArtifacts: ["artifacts/report.md"], additionalUnpreservedArtifacts: 0, pendingResults: [], additionalPendingResults: 0, pendingPreservations: [], additionalPendingPreservations: 0 }],
      prepared: [{ preparedId: "prepared_aaaaaaaaaaaaaaaaaaaaaaaa", ownerSession: "/parent.jsonl",owner:{file:"/parent.jsonl",state:"unnamed",id:"parent",label:"parent"}, status: "ready", class: "due", taskIds: ["personal-test"],taskFacts:[{id:"personal-test",status:"closed"}], reason: "All inherited tasks are closed." }],
      leftovers: [{ leftoverId:`leftover_${"a".repeat(24)}`,kind: "worker_host_log", id: "job_20261023100002_aaaaaaaa", path: "/project/.pi/async-shell/jobs/job_20261023100002_aaaaaaaa", eligible: true, reason: "passed", device: 1, inode: 2,mtimeMs:1 }],
      total: { workers: 1, prepared: 1, leftovers: 1 }, scan: { partial: false, examinedWorkers: 1, totalWorkers: 1, examinedFilesystemEntries: 1,roots:[{root:"/workers",examined:1,partial:false}] }, generatedAt: "2026-10-25T10:00:02.000Z", nextOffset: 20
    } }
  };
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, value), true);
  const malformed = structuredClone(value) as any; malformed.details.inventory.workers[0].rawSummary = "untrusted";
  assert.equal(Check(RetainedToolOutputSchemas.worker_control, malformed), false);
});

test("worker_control cleanup preview and apply outputs retain strict authority evidence",()=>{
 const owner={file:"/retired.jsonl",state:"named",id:"retired",name:"Retired",label:"Retired"};const scan={partial:false,examinedWorkers:0,totalWorkers:0,examinedFilesystemEntries:0,roots:[]};const token=`cleanup_${"a".repeat(48)}`;const preview={content:[{type:"text",text:"cleanup preview"}],details:{token,snapshotHash:"b".repeat(64),createdAt:"2026-10-25T10:00:02.000Z",workers:[],prepared:[{preparedId:`prepared_${"c".repeat(24)}`,ownerSession:"/retired.jsonl",owner,status:"partial",class:"partial",taskIds:["personal-test"],taskFacts:[{id:"personal-test",status:"closed"}],reason:"Application is partial.",authority:{state:"dead",generation:1,members:[]}}],leftovers:[],scan}};assert.equal(Check(RetainedToolOutputSchemas.worker_control,preview),true);const extra=structuredClone(preview) as any;extra.details.prepared[0].authority="forged";assert.equal(Check(RetainedToolOutputSchemas.worker_control,extra),false);const applied={content:[{type:"text",text:"1/2 cleanup items discarded"}],details:{cleanup:{token,results:[{kind:"worker",id:"worker_20261025100002_aaaaaaaa",status:"failed",reason:"exact preflight failed"},{kind:"leftover",id:`leftover_${"d".repeat(24)}`,status:"discarded"}]}}};assert.equal(Check(RetainedToolOutputSchemas.worker_control,applied),true);
});
