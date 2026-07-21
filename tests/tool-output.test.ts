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
  outputBytes
};
const jobMeta = {
  ...jobStart,
  shell: "/bin/zsh",
  pid: 42,
  startedAt: "2026-07-21T00:00:00.000Z",
  endedAt: "2026-07-21T00:00:00.005Z",
  notifyOnExit: true,
  completionNotified: false,
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
        path: "a.ts",
        resolvedPath: "/repo/a.ts",
        offset: 1,
        requestedLimit: 10,
        truncation,
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
  orchestrate: {
    content: [text("Orchestrate: 0/1 tasks succeeded")],
    details: {
      mode: "read-only",
      configSource: "/repo/config/orchestrator-settings.json",
      results: [{
        id: "task-1",
        role: "reader",
        status: "failed",
        error: "Provider unavailable",
        output: "",
        model: "openai-codex/gpt-5.6-sol",
        thinkingLevel: "medium",
        toolCallCount: 0,
        durationMs: 0,
        deniedCalls: [],
        routeAttempts: [{
          model: "openai-codex/gpt-5.6-sol",
          status: "failed",
          failureKind: "transient",
          error: "Provider unavailable"
        }]
      }]
    }
  },
  reconcile: {
    content: [text("Nothing merged")],
    details: {
      status: "nothing_merged",
      folded: [],
      skipped: [{ branch: "orch/missing", status: "invalid", reason: "Branch does not exist." }],
      overlaps: [],
      validation: "unvalidated",
      cleanedBranches: []
    }
  }
};

test("authoritative output schemas accept representative runtime results and generic errors", () => {
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(RetainedToolOutputSchemas).sort());
  for (const [name, schema] of Object.entries(RetainedToolOutputSchemas) as Array<[RetainedToolName, typeof RetainedToolOutputSchemas[RetainedToolName]]>) {
    assert.equal(Check(schema, samples[name]), true, `${name} representative result matches its output schema`);
    assert.equal(Check(schema, { content: [text("Tool failed")], details: {} }), true, `${name} accepts Pi's generic runtime error result`);
    assert.equal(Check(schema, { ...(samples[name] as object), unexpected: true }), false, `${name} rejects unknown top-level fields`);
  }
  assert.equal(Check(RuntimeErrorResultSchema, { content: [text("Tool failed")], details: {} }), true);
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
  const readByteTruncation = structuredClone(samples.read_many) as { details: { files: Array<{ truncation: { truncatedBy: string | null } }> } };
  readByteTruncation.details.files[0]!.truncation.truncatedBy = "bytes";
  assert.equal(Check(RetainedToolOutputSchemas.read_many, readByteTruncation), true, "read_many retains byte-truncation support");

  assert.equal(Check(RetainedToolOutputSchemas.orchestrate, { ...(samples.orchestrate as object), isError: true }), false, "raw execute isError is not a tool-result field");
  assert.equal(Check(RetainedToolOutputSchemas.reconcile, { ...(samples.reconcile as object), isError: true }), false, "raw execute isError is not a tool-result field");

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

  assert.equal(Check(RetainedToolOutputSchemas.reconcile, {
    content: [text("Merged integration")],
    details: {
      status: "merged",
      integrationBranch: "orch/integration-1",
      integrationPath: "/repo/.pi/worktrees/integration-1",
      mergeCommit: hash,
      folded: [{ branch: "orch/task-1", changedFiles: ["a.ts"] }],
      skipped: [],
      overlaps: [],
      validation: "passed-per-fold",
      cleanedBranches: ["orch/task-1"]
    }
  }), true, "reconcile accepts its merged report variant");
});
