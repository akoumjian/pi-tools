import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SessionManager,
  parseSessionEntries,
  type FileEntry,
  type SessionHeader
} from "@earendil-works/pi-coding-agent";

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
  const exact = path.resolve(sessionFile);
  const entries = parseSessionEntries(readWorkerSessionText(exact, sessionDir));
  const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
  if (!header || header.id !== input.sessionId || path.resolve(header.cwd) !== workspaceRoot || header.parentSession) {
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

  return verifyWorkerSession({
    sessionFile,
    sessionDir,
    sessionId: input.sessionId,
    workspaceRoot,
    parentSessionFile
  });
}

export function verifyWorkerSession(input: {
  sessionFile: string;
  sessionDir: string;
  sessionId: string;
  workspaceRoot: string;
  parentSessionFile: string;
}): WorkerSessionIdentity {
  const sessionFile = path.resolve(input.sessionFile);
  const workspaceRoot = realpathSync(input.workspaceRoot);
  const parentSessionFile = realpathSync(input.parentSessionFile);
  const raw = readWorkerSessionText(sessionFile, input.sessionDir);
  const entries = parseSessionEntries(raw);
  const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
  if (!header) throw new Error(`Worker session has no header: ${sessionFile}`);
  if (header.id !== input.sessionId) {
    throw new Error(`Worker session id mismatch: expected ${input.sessionId}, found ${header.id}.`);
  }
  if (path.resolve(header.cwd) !== workspaceRoot) {
    throw new Error(`Worker session cwd mismatch: expected ${workspaceRoot}, found ${header.cwd}.`);
  }
  if (!header.parentSession || realpathSync(header.parentSession) !== parentSessionFile) {
    throw new Error(`Worker session parent mismatch: expected ${parentSessionFile}, found ${header.parentSession ?? "none"}.`);
  }

  return {
    sessionId: header.id,
    sessionFile,
    sessionDir: path.dirname(sessionFile),
    workspaceRoot,
    parentSessionFile,
    entries
  };
}

export function readWorkerSessionText(sessionFile: string, sessionDir: string, maximumBytes = 128 * 1024 * 1024): string {
  const rootPath = path.resolve(sessionDir);
  if (lstatSync(rootPath).isSymbolicLink() || !lstatSync(rootPath).isDirectory()) throw new Error("Worker session directory must be an ordinary directory.");
  const root = realpathSync(rootPath); const lexical = path.resolve(sessionFile); const relative = path.relative(root, lexical);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Worker session file must remain beneath its retained session directory.");
  let current = root;
  for (const component of relative.split(path.sep)) { current = path.join(current, component); if (lstatSync(current).isSymbolicLink()) throw new Error("Worker session file may not traverse symbolic links."); }
  const descriptor = openSync(lexical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { const metadata = fstatSync(descriptor); if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error(`Worker session must be an ordinary file no larger than ${maximumBytes} bytes.`); return readFileSync(descriptor, "utf8"); }
  finally { closeSync(descriptor); }
}
