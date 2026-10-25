import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SessionManager,
  parseSessionEntries,
  type FileEntry,
  type SessionHeader
} from "@earendil-works/pi-coding-agent";

const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const MAX_RETURNED_SESSION_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_TEXT_BYTES = 128 * 1024 * 1024;

export type ForkWorkerSessionInput = {
  parentSessionFile: string;
  workspaceRoot: string;
  sessionDir: string;
  sessionId: string;
};

export type WorkerSessionIdentity = {
  sessionId: string;
  sessionFile: string;
  sessionDir: string;
  workspaceRoot: string;
  parentSessionFile: string;
  /** Complete for ordinary sessions; header-only when the retained session exceeds the bounded return budget. */
  entries: FileEntry[];
};

export function createWorkerSession(input: { workspaceRoot: string; sessionDir: string; sessionId: string }): WorkerSessionIdentity {
  const workspaceRoot = realpathSync(input.workspaceRoot);
  const sessionDir = path.resolve(input.sessionDir);
  mkdirSync(sessionDir, { recursive: true });
  const manager = SessionManager.create(workspaceRoot, sessionDir, { id: input.sessionId });
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Pi did not allocate the fresh worker session.");
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, `${JSON.stringify(manager.getHeader())}\n`, { mode: 0o600 });
  const { sessionFile: exact, header, entries } = readWorkerSessionHeader(sessionFile, { includeEntries: true, sessionDir });
  if (header.id !== input.sessionId || realpathOrResolve(header.cwd) !== workspaceRoot || header.parentSession) {
    throw new Error(`Fresh worker session identity mismatch: ${exact}.`);
  }
  return { sessionId: header.id, sessionFile: exact, sessionDir: path.dirname(exact), workspaceRoot, parentSessionFile: "", entries };
}

export function forkWorkerSession(input: ForkWorkerSessionInput): WorkerSessionIdentity {
  const parentSessionFile = realpathSync(input.parentSessionFile);
  const workspaceRoot = realpathSync(input.workspaceRoot);
  const sessionDir = path.resolve(input.sessionDir);
  mkdirSync(sessionDir, { recursive: true });
  const manager = SessionManager.forkFrom(parentSessionFile, workspaceRoot, sessionDir, { id: input.sessionId });
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Pi did not persist the forked worker session.");
  return verifyWorkerSession({ sessionFile, sessionDir, sessionId: input.sessionId, workspaceRoot, parentSessionFile }, { includeEntries: true });
}

export function verifyWorkerSession(input: {
  sessionFile: string;
  sessionDir?: string;
  sessionId: string;
  workspaceRoot: string;
  parentSessionFile: string;
}, options: { includeEntries?: boolean } = {}): WorkerSessionIdentity {
  const { sessionFile, header, entries } = readWorkerSessionHeader(input.sessionFile, { ...options, sessionDir: input.sessionDir ?? path.dirname(input.sessionFile) });
  const workspaceRoot = realpathSync(input.workspaceRoot);
  const parentSessionFile = realpathSync(input.parentSessionFile);
  if (header.id !== input.sessionId) throw new Error(`Worker session id mismatch: expected ${input.sessionId}, found ${header.id}.`);
  if (realpathOrResolve(header.cwd) !== workspaceRoot) throw new Error(`Worker session cwd mismatch: expected ${workspaceRoot}, found ${header.cwd}.`);
  if (!header.parentSession || realpathSync(header.parentSession) !== parentSessionFile) {
    throw new Error(`Worker session parent mismatch: expected ${parentSessionFile}, found ${header.parentSession ?? "none"}.`);
  }
  return { sessionId: header.id, sessionFile, sessionDir: path.dirname(sessionFile), workspaceRoot, parentSessionFile, entries };
}

export function readWorkerSessionHeader(file: string, options: { includeEntries?: boolean; sessionDir?: string } = {}): { sessionFile: string; header: SessionHeader; entries: FileEntry[] } {
  const { requested, exact } = containedSessionFile(file, options.sessionDir);
  const leaf = lstatSync(requested);
  let fd: number;
  try { fd = openSync(requested, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error(`Worker session file could not be opened safely: ${requested}`); }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== leaf.dev || opened.ino !== leaf.ino) throw new Error(`Worker session changed during verification: ${requested}`);
    const first = readFirstLine(fd, opened.size);
    let value: unknown;
    try { value = JSON.parse(first); } catch { throw new Error(`Worker session header is malformed: ${requested}`); }
    if (!isSessionHeader(value)) throw new Error(`Worker session has no valid header: ${requested}`);
    const entries = options.includeEntries && opened.size <= MAX_RETURNED_SESSION_BYTES ? parseSessionEntries(readSnapshot(fd, opened.size)) : [value];
    const after = fstatSync(fd);
    const current = lstatSync(requested);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || after.dev !== opened.dev || after.ino !== opened.ino || after.size < opened.size) throw new Error(`Worker session changed during verification: ${requested}`);
    return { sessionFile: exact, header: value, entries };
  } finally { closeSync(fd); }
}

export function readWorkerSessionText(sessionFile: string, sessionDir: string, maximumBytes = MAX_SESSION_TEXT_BYTES): string {
  const { requested } = containedSessionFile(sessionFile, sessionDir);
  const descriptor = openSync(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error(`Worker session must be an ordinary file no larger than ${maximumBytes} bytes.`);
    return readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
}

function containedSessionFile(file: string, sessionDir?: string): { requested: string; exact: string } {
  const requested = path.resolve(file);
  let leaf;
  try { leaf = lstatSync(requested); } catch { throw new Error(`Worker session file is unavailable: ${requested}`); }
  if (leaf.isSymbolicLink() || !leaf.isFile()) throw new Error(`Worker session path is not a safe regular file: ${requested}`);
  if (sessionDir !== undefined) {
    const rootPath = path.resolve(sessionDir);
    const rootStat = lstatSync(rootPath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Worker session directory must be an ordinary directory.");
    const relative = path.relative(rootPath, requested);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Worker session file must remain beneath its retained session directory.");
    let current = rootPath;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      if (lstatSync(current).isSymbolicLink()) throw new Error("Worker session file may not traverse symbolic links.");
    }
    const root = realpathSync(rootPath);
    const exact = realpathSync(requested);
    const exactRelative = path.relative(root, exact);
    if (exactRelative === "" || exactRelative === ".." || exactRelative.startsWith(`..${path.sep}`) || path.isAbsolute(exactRelative)) throw new Error("Worker session file resolves outside its retained session directory.");
    return { requested, exact };
  }
  return { requested, exact: realpathSync(requested) };
}

function readFirstLine(fd: number, size: number): string {
  const length = Math.min(size, MAX_SESSION_HEADER_BYTES + 1);
  const buffer = Buffer.allocUnsafe(Math.max(1, length));
  const count = length === 0 ? 0 : readSync(fd, buffer, 0, length, 0);
  const newline = buffer.subarray(0, count).indexOf(0x0a);
  if (newline < 0) throw new Error(count > MAX_SESSION_HEADER_BYTES ? "Worker session header exceeds its read bound." : "Worker session has no complete header.");
  return decodeUtf8(buffer.subarray(0, newline));
}

function readSnapshot(fd: number, size: number): string {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, buffer, offset, size - offset, offset);
    if (count === 0) throw new Error("Worker session was truncated during verification.");
    offset += count;
  }
  return decodeUtf8(buffer);
}

function decodeUtf8(value: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new Error("Worker session is not valid UTF-8."); }
}

function isSessionHeader(value: unknown): value is SessionHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.type === "session" && typeof item.id === "string" && typeof item.cwd === "string" && typeof item.timestamp === "string" && (item.parentSession === undefined || typeof item.parentSession === "string");
}
function realpathOrResolve(value: string): string { try { return realpathSync(value); } catch { return path.resolve(value); } }
