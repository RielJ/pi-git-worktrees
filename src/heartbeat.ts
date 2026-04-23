/**
 * heartbeat — Track live Pi processes across tmux panes.
 *
 * Each Pi process writes a JSON heartbeat file every 2 seconds.
 * Other instances can query listActive() to discover who's alive,
 * what they're working on, and whether they're mid-turn.
 *
 * Based on pi-mux's heartbeat.ts by @leohenon, extended with
 * worktreeId tracking for git worktree management.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

export interface Heartbeat {
  paneId: string;
  sessionFile: string;
  cwd: string;
  pid: number;
  owner: string;
  busy: boolean;
  /** Display label (session name or first user message) */
  label?: string;
  /** Git worktree ID if this is a worktree session */
  worktreeId?: string;
  /** Git branch name */
  branch?: string;
  /** Current activity description */
  activity?: string;
  /** Path of the session this one was forked/spawned from */
  parentSessionFile?: string;
}

// ── Constants ───────────────────────────────────────────────────────

const DIR = join(homedir(), ".pi-git-worktrees", "heartbeats");
const INTERVAL_MS = 2000;
const STALE_MS = 5000;

// ── State ───────────────────────────────────────────────────────────

let currentPath: string | undefined;
let currentEntry: Heartbeat | undefined;
let tickHandle: ReturnType<typeof setInterval> | undefined;

// ── File path ───────────────────────────────────────────────────────

function filePath(paneId: string): string {
  return join(DIR, `${paneId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

// ── Start / Stop ────────────────────────────────────────────────────

export function start(entry: Heartbeat): void {
  mkdirSync(DIR, { recursive: true });
  currentPath = filePath(entry.paneId);
  currentEntry = entry;
  writeCurrent();
  const tick = setInterval(() => {
    if (!currentPath) return;
    const now = new Date();
    try {
      utimesSync(currentPath, now, now);
    } catch {
      writeCurrent();
    }
  }, INTERVAL_MS);
  if (typeof tick.unref === "function") tick.unref();
  tickHandle = tick;
}

export function stop(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = undefined;
  }
  if (currentPath) {
    try {
      unlinkSync(currentPath);
    } catch {}
    currentPath = undefined;
  }
  currentEntry = undefined;
}

// ── Update helpers ──────────────────────────────────────────────────

export function setBusy(busy: boolean): void {
  if (!currentEntry) return;
  if (currentEntry.busy === busy) return;
  currentEntry = { ...currentEntry, busy };
  writeCurrent();
}

export function setLabel(label: string | undefined): void {
  if (!currentEntry) return;
  const next = label && label.trim() ? label.trim() : undefined;
  if (currentEntry.label === next) return;
  currentEntry = { ...currentEntry, label: next };
  writeCurrent();
}

export function setActivity(activity: string | undefined): void {
  if (!currentEntry) return;
  if (currentEntry.activity === activity) return;
  currentEntry = { ...currentEntry, activity };
  writeCurrent();
}

export function setWorktreeId(worktreeId: string | undefined): void {
  if (!currentEntry) return;
  if (currentEntry.worktreeId === worktreeId) return;
  currentEntry = { ...currentEntry, worktreeId };
  writeCurrent();
}

export function getCurrent(): Heartbeat | undefined {
  return currentEntry;
}

// ── Query ───────────────────────────────────────────────────────────

/**
 * Return all Pi instances with a fresh heartbeat + live pid.
 * Stale/dead heartbeat files are cleaned up automatically.
 */
export function listActive(): Heartbeat[] {
  const cutoff = Date.now() - STALE_MS;
  const result: Heartbeat[] = [];
  for (const name of readDirSafe()) {
    const full = join(DIR, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const data = readEntry(full);
    const fresh = mtimeMs >= cutoff;
    if (!data || !pidAlive(data.pid) || !fresh) {
      try {
        unlinkSync(full);
      } catch {}
      continue;
    }
    result.push(data);
  }
  return result;
}

/**
 * Find a live heartbeat for a specific worktree ID.
 */
export function findByWorktreeId(worktreeId: string): Heartbeat | undefined {
  return listActive().find((hb) => hb.worktreeId === worktreeId);
}

/**
 * Find a live heartbeat by session file path.
 */
export function findBySessionFile(sessionFile: string): Heartbeat | undefined {
  return listActive().find((hb) => hb.sessionFile === sessionFile);
}

// ── Internal helpers ────────────────────────────────────────────────

function writeCurrent(): void {
  if (!currentPath || !currentEntry) return;
  try {
    writeFileSync(currentPath, JSON.stringify(currentEntry));
  } catch {}
}

function readDirSafe(): string[] {
  if (!existsSync(DIR)) return [];
  try {
    return readdirSync(DIR);
  } catch {
    return [];
  }
}

function readEntry(full: string): Heartbeat | undefined {
  try {
    const data = JSON.parse(readFileSync(full, "utf8")) as Partial<Heartbeat>;
    if (
      typeof data.paneId === "string" &&
      typeof data.sessionFile === "string" &&
      typeof data.cwd === "string" &&
      typeof data.pid === "number" &&
      typeof data.owner === "string"
    ) {
      return {
        paneId: data.paneId,
        sessionFile: data.sessionFile,
        cwd: data.cwd,
        pid: data.pid,
        owner: data.owner,
        busy: typeof data.busy === "boolean" ? data.busy : false,
        label: typeof data.label === "string" ? data.label : undefined,
        worktreeId: typeof data.worktreeId === "string" ? data.worktreeId : undefined,
        branch: typeof data.branch === "string" ? data.branch : undefined,
        activity: typeof data.activity === "string" ? data.activity : undefined,
        parentSessionFile:
          typeof data.parentSessionFile === "string"
            ? data.parentSessionFile
            : undefined,
      };
    }
  } catch {
    try {
      unlinkSync(full);
    } catch {}
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
