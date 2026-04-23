/**
 * tmux — Manage worktree Pi agents as windows in a single hidden session.
 *
 * All worktree Pis live as named windows inside one `_pi-wt` session.
 * The user views/interacts via `tmux display-popup` which overlays the
 * current pane. Dismissing the popup (detach) hides it — the agent
 * keeps running. Zero tmux state mutation on the user's session.
 *
 * Layout:
 *   _pi-wt (hidden session)
 *   ├── window "fix-auth"   ← Pi agent running
 *   ├── window "refactor"   ← Pi agent running
 *   └── ...
 *
 * Requires tmux 3.2+.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const POOL_SESSION = "_pi-wt";
const READY_DIR = join(tmpdir(), "pi-wt-ready");

// ── Tmux detection ──────────────────────────────────────────────────

export function inTmux(): boolean {
  return Boolean(process.env.TMUX && process.env.TMUX_PANE);
}

// ── Ready file signaling ────────────────────────────────────────────

/**
 * Called by the spawned Pi's session_start to signal it's ready.
 */
export function signalReady(): void {
  const readyFile = process.env.PI_WT_READY_FILE;
  if (!readyFile) return;
  try {
    writeFileSync(readyFile, "");
  } catch {}
}

// ── Pool session management ─────────────────────────────────────────

function ensurePoolSession(): void {
  try {
    execFileSync("tmux", ["has-session", "-t", POOL_SESSION], { stdio: "ignore" });
  } catch {
    // Pool doesn't exist — create it with a dummy window (will be replaced)
    execFileSync("tmux", [
      "new-session", "-d", "-s", POOL_SESSION, "-x", "200", "-y", "50",
    ]);
    // Prevent auto-destroy when all windows close
    try {
      execFileSync("tmux", ["set-option", "-t", POOL_SESSION, "destroy-unattached", "off"], { stdio: "ignore" });
    } catch {}
  }
}

// ── Core: Spawn a Pi process as a window in the pool session ────────

/**
 * Create a new window in the _pi-wt session and run Pi in it.
 * Nothing visible changes for the user — the pool session is hidden.
 *
 * @param worktreeId - Worktree identifier (used as window name)
 * @param command - The pi command to run
 * @param cwd - Working directory (the worktree path)
 * @returns true if the window was created successfully
 */
export function spawnWorktreeSession(
  worktreeId: string,
  command: string,
  cwd: string,
): boolean {
  // Kill any existing window with the same name
  killWorktreeSession(worktreeId);

  ensurePoolSession();

  mkdirSync(READY_DIR, { recursive: true });
  const readyFile = join(READY_DIR, randomUUID());

  try {
    // Create a new window in the pool session
    execFileSync("tmux", [
      "new-window",
      "-d",                              // don't switch to it
      "-t", `${POOL_SESSION}:`,          // target: pool session, auto-assign index
      "-n", worktreeId,                  // window name
      "-c", cwd,                         // working directory
      "-e", `PI_WT_READY_FILE=${readyFile}`,
    ]);

    // Send the pi command to the new window
    execFileSync("tmux", [
      "send-keys", "-t", `${POOL_SESSION}:${worktreeId}`,
      ` ${command}`,
      "Enter",
    ]);

    // Wait for Pi to signal ready (session_start fires signalReady)
    waitForReady(readyFile, 10000);

    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(readyFile, { force: true });
    } catch {}
  }
}

/**
 * Open a floating popup that shows a worktree's window.
 * The popup attaches to the pool session and selects the worktree's window.
 * Detaching dismisses the popup — the window keeps running.
 *
 * @param worktreeId - Worktree identifier
 * @param width - Popup width (default "95%")
 * @param height - Popup height (default "95%")
 */
export function openPopup(
  worktreeId: string,
  width = "95%",
  height = "95%",
): void {
  if (!isSessionAlive(worktreeId)) {
    throw new Error(`Worktree "${worktreeId}" is not running`);
  }

  // Select the target window first, then attach to the session in the popup
  try {
    execFileSync("tmux", [
      "select-window", "-t", `${POOL_SESSION}:${worktreeId}`,
    ], { stdio: "ignore" });
  } catch {}

  try {
    execFileSync("tmux", [
      "display-popup",
      "-w", width,
      "-h", height,
      "-E",
      `tmux attach -t ${POOL_SESSION}`,
    ], {
      stdio: "ignore",
    });
  } catch {
    // popup dismissed — normal
  }
}

/**
 * Kill a worktree's window in the pool session.
 */
export function killWorktreeSession(worktreeId: string): void {
  try {
    execFileSync("tmux", [
      "kill-window", "-t", `${POOL_SESSION}:${worktreeId}`,
    ], { stdio: "ignore" });
  } catch {}
}

/**
 * Check if a worktree's window is still alive in the pool session.
 */
export function isSessionAlive(worktreeId: string): boolean {
  try {
    execFileSync("tmux", [
      "display-message", "-t", `${POOL_SESSION}:${worktreeId}`, "-p", "",
    ], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all active worktree window names in the pool session.
 */
export function listWorktreeSessions(): string[] {
  try {
    const out = execFileSync("tmux", [
      "list-windows", "-t", POOL_SESSION, "-F", "#{window_name}",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Send keys (text input) to a worktree's window.
 */
export function sendKeysToSession(worktreeId: string, text: string): void {
  try {
    execFileSync("tmux", [
      "send-keys", "-t", `${POOL_SESSION}:${worktreeId}`,
      text, "Enter",
    ]);
  } catch {}
}

// ── Cleanup ─────────────────────────────────────────────────────────

/**
 * Kill the entire pool session (all worktree windows).
 */
export function killPoolSession(): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", POOL_SESSION], { stdio: "ignore" });
  } catch {}
}

// ── Helpers ─────────────────────────────────────────────────────────

function waitForReady(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    sleepMs(10);
  }
}

function sleepMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}
