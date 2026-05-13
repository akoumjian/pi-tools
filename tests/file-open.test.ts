import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fileOpenExtension, {
  buildEditorInvocation,
  collectRecentFileReferences,
  extractPathCandidatesFromText,
  readFileOpenSettings,
  resolveFileReferenceCandidate,
  tokenizeCommand
} from "../extensions/file-open/index.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-file-open-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeTestFile(root: string, relativePath: string, content = "test\n"): Promise<string> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
}

function relativeToRealRoot(root: string, filePath: string): string {
  return path.relative(realpathSync(root), filePath);
}

test("file-open extension registers /file:open without stealing Ctrl+E by default", () => {
  const commands: string[] = [];
  const shortcuts: string[] = [];
  fileOpenExtension({
    registerCommand(name: string): void {
      commands.push(name);
    },
    registerShortcut(shortcut: string): void {
      shortcuts.push(shortcut);
    }
  } as unknown as ExtensionAPI);

  assert.deepEqual(commands, ["file:open"]);
  assert.deepEqual(shortcuts, []);
});

test("readFileOpenSettings keeps shortcut optional and validates explicit config", async () => {
  await withTempDir(async (root) => {
    const configPath = path.join(root, "file-open-settings.json");
    await writeFile(configPath, JSON.stringify({ shortcut: "ctrl+e", maxReferences: 5 }), "utf8");

    const settings = readFileOpenSettings(configPath);
    assert.equal(settings.shortcut, "ctrl+e");
    assert.equal(settings.maxReferences, 5);
    assert.match(settings.configSource, /explicit:/);
  });

  const defaults = readFileOpenSettings();
  assert.equal(defaults.shortcut, undefined);
  assert.equal(defaults.maxReferences, 80);
  assert.match(defaults.configSource, /file-open-settings\.json/);
});

test("collectRecentFileReferences finds existing paths from recent tool results and chat", async () => {
  await withTempDir(async (root) => {
    const fooPath = await writeTestFile(root, "src/foo.ts", "one\ntwo\nthree\n");
    const reportPath = await writeTestFile(root, "docs/report.md", "# Report\nbody\n");
    await writeTestFile(root, "notes/older.txt", "older\n");

    const entries = [
      {
        type: "message",
        message: {
          role: "user",
          content: "Please inspect src/foo.ts:2:3 and missing.ts:1.",
          timestamp: 1
        }
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read_many",
              arguments: { files: [{ path: "notes/older.txt" }] }
            }
          ],
          timestamp: 2
        }
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "read_many",
          details: {
            files: [
              {
                path: "docs/report.md",
                resolvedPath: reportPath,
                offset: 2
              }
            ]
          },
          content: [{ type: "text", text: "--- docs/report.md (lines 2-2 of 2) ---\nbody" }],
          timestamp: 3
        }
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "search_many",
          details: { searches: [] },
          content: [
            {
              type: "text",
              text: "--- search 1 ---\nsrc/foo.ts:2:3:two\nmissing.ts:1:1:nope"
            }
          ],
          timestamp: 4
        }
      }
    ];

    const references = collectRecentFileReferences(entries, root);
    const simplified = references.map((reference) => [
      relativeToRealRoot(root, reference.realPath),
      reference.line,
      reference.column,
      reference.sourceLabel
    ]);

    assert.deepEqual(simplified.slice(0, 3), [
      ["src/foo.ts", 2, 3, "search_many result"],
      ["docs/report.md", 2, undefined, "read_many details"],
      ["notes/older.txt", undefined, undefined, "read_many call arguments"]
    ]);
    assert.equal(references.some((reference) => reference.realPath.endsWith("missing.ts")), false);
    assert.equal(references[0].realPath, realpathSync(fooPath));
  });
});

test("collectRecentFileReferences includes saved artifact paths from structured details", async () => {
  await withTempDir(async (root) => {
    const outputPath = await writeTestFile(root, ".pi/docparser/output.txt", "parsed\n");
    const screenshotPath = await writeTestFile(root, ".pi/docparser/screens/page-1.png", "png\n");

    const references = collectRecentFileReferences([
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "document_parse",
          details: {
            outputPath,
            screenshotPathsPreview: [screenshotPath],
            documentParseHint: { path: outputPath }
          },
          content: [{ type: "text", text: `Saved to ${outputPath}` }]
        }
      }
    ], root);

    assert.deepEqual(references.map((reference) => relativeToRealRoot(root, reference.realPath)), [
      ".pi/docparser/output.txt",
      ".pi/docparser/screens/page-1.png"
    ]);
  });
});

test("extractPathCandidatesFromText and resolveFileReferenceCandidate handle common reference syntax", async () => {
  await withTempDir(async (root) => {
    const filePath = await writeTestFile(root, "lib/example.ts", "alpha\n");
    const candidates = extractPathCandidatesFromText("See `@lib/example.ts:12:4`\nlib/example.ts-13-5-context", root, "test");
    const resolved = candidates
      .map((candidate) => resolveFileReferenceCandidate(candidate, root))
      .filter((reference): reference is NonNullable<typeof reference> => reference !== undefined && reference.line !== undefined);

    assert.deepEqual(resolved.map((reference) => [reference.realPath, reference.line, reference.column]), [
      [realpathSync(filePath), 12, 4],
      [realpathSync(filePath), 13, 5]
    ]);
  });
});

test("buildEditorInvocation uses VISUAL-style command tokens and editor-specific line arguments", () => {
  const reference = { realPath: "/tmp/example.ts", line: 7, column: 2 };

  assert.deepEqual(buildEditorInvocation(reference, "hx"), {
    command: "hx",
    args: ["/tmp/example.ts:7:2"],
    target: "/tmp/example.ts:7:2"
  });

  assert.deepEqual(buildEditorInvocation(reference, "code --wait"), {
    command: "code",
    args: ["--wait", "--goto", "/tmp/example.ts:7:2"],
    target: "/tmp/example.ts:7:2"
  });

  assert.deepEqual(buildEditorInvocation(reference, "vim -n"), {
    command: "vim",
    args: ["-n", "+call cursor(7, 2)", "/tmp/example.ts"],
    target: "/tmp/example.ts"
  });

  assert.deepEqual(buildEditorInvocation(reference, "nano -w"), {
    command: "nano",
    args: ["-w", "/tmp/example.ts"],
    target: "/tmp/example.ts"
  });
});

test("tokenizeCommand supports quoted editor paths", () => {
  assert.deepEqual(tokenizeCommand('"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --wait'), [
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "--wait"
  ]);
  assert.throws(() => tokenizeCommand("'unterminated"), /Unterminated quoted editor command/);
});
