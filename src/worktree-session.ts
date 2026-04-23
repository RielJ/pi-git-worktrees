/**
 * WorktreeSessionManager — manages Pi session files for worktrees.
 *
 * Uses SessionManager.create(cwd, sessionDir) to create sessions
 * with the correct cwd (worktree path). Each session gets a custom
 * metadata entry so we can detect worktree sessions on load.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { SessionManager, type ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Custom entry type for worktree session identification ───────────

const CUSTOM_TYPE = "pi-git-worktrees/session";

export interface WorktreeSessionMetadata {
  worktreeId: string;
  mainSessionPath: string;
  branch: string;
  task: string;
  createdAt: string;
}

// ── Session Manager ─────────────────────────────────────────────────

export class WorktreeSessionManager {
  private sessionsDir: string;

  constructor(private repoRoot: string) {
    this.sessionsDir = join(repoRoot, ".pi", "git-worktrees", "sessions");
  }

  /**
   * Create a new Pi session for a worktree.
   *
   * Uses SessionManager.create(worktreePath, sessionsDir) which sets
   * the session header's cwd to the worktree path. When Pi switches
   * to this session, tools will execute in the worktree directory.
   *
   * Seeds the session with:
   * 1. A custom metadata entry (for detection on reload)
   * 2. The task as a user message (agent starts working immediately)
   */
  createSession(opts: {
    worktreeId: string;
    worktreePath: string;
    task: string;
    branch: string;
    mainSessionPath: string;
  }): { sessionFile: string } {
    const { worktreeId, worktreePath, task, branch, mainSessionPath } = opts;

    // Ensure sessions directory exists
    mkdirSync(this.sessionsDir, { recursive: true });

    // Create session with worktree as cwd
    const sm = SessionManager.create(worktreePath, this.sessionsDir);
    const sessionFile = sm.getSessionFile()!;

    // Build entries manually and write to disk directly.
    // We can't rely on SessionManager._persist() because it only
    // flushes once an assistant message exists.
    //
    // We write ONLY the session header + custom metadata.
    // The task is NOT pre-seeded as a user message here because
    // Pi treats resumed sessions as read-only history and won't
    // auto-trigger a turn. Instead, switchToWorktree() sends the
    // task as a real user message after the first switch.

    const now = new Date().toISOString();

    // Get the session header entry from SM's internal state
    const entries: any[] = (sm as any).fileEntries || [];
    const headerEntry = entries.find((e: any) => e.type === "session");

    const customEntry = {
      type: "custom",
      customType: CUSTOM_TYPE,
      data: {
        worktreeId,
        mainSessionPath,
        branch,
        task,
        createdAt: now,
      } as WorktreeSessionMetadata,
      id: generateId(),
      parentId: null,
      timestamp: now,
    };

    // Write only header + metadata to disk
    const allEntries = headerEntry
      ? [headerEntry, customEntry]
      : [customEntry];

    const content = allEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(sessionFile, content);

    return { sessionFile };
  }

  /**
   * Get the sessions directory path.
   */
  getSessionsDir(): string {
    return this.sessionsDir;
  }

  /**
   * Spawn a headless Pi process to execute the task in the background.
   * The process runs non-interactively (`pi -p`) with the worktree's
   * session file. All output is written to the session file so when
   * the user switches to it, they see the full transcript.
   *
   * Returns the child process for monitoring.
   */
  spawnBackgroundAgent(opts: {
    sessionFile: string;
    worktreePath: string;
    task: string;
    /** If true, use `-c` to continue existing session instead of new prompt */
    continueSession?: boolean;
  }): ChildProcess {
    const { sessionFile, worktreePath, task, continueSession } = opts;

    const args: string[] = ["-p", "--session", sessionFile];
    if (continueSession) {
      // `-c` tells Pi to continue the last session (resume pending turn)
      args.push("-c");
    }
    if (task) {
      args.push(task);
    }

    const child = spawn("pi", args, {
      cwd: worktreePath,
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        PI_GIT_WORKTREES_BACKGROUND: "1",
      },
    });

    // Detach so it survives if the parent Pi process exits
    child.unref();

    return child;
  }
}

// ── ID generator ──────────────────────────────────────────────────

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── Detection helper ────────────────────────────────────────────────

/**
 * Detect if the current session is a worktree session.
 * Scans session entries for our custom metadata entry.
 *
 * Returns the metadata if found, null otherwise.
 */
export function detectWorktreeSession(
  ctx: ExtensionContext,
): WorktreeSessionMetadata | null {
  try {
    const entries = ctx.sessionManager.getBranch();
    for (const entry of entries) {
      const e = entry as any;
      if (e.type === "custom" && e.customType === CUSTOM_TYPE && e.data) {
        return e.data as WorktreeSessionMetadata;
      }
    }
  } catch {
    // Session might not have entries yet
  }
  return null;
}
