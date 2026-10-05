/**
 * auto-escape — Start fresh sessions from the main repo, not a worktree.
 *
 * Annoyance: open a new terminal inside a worktree (or hit /new while the
 * session cwd is a worktree) and the new Pi session inherits the worktree
 * directory. The user then has to manually cd back to main.
 *
 * Fix: on fresh sessions (no worktree metadata) whose cwd sits inside a git
 * worktree, redirect to the main repo root:
 * - process.chdir(mainRoot) so relative paths resolve to main
 * - patch SessionManager's in-memory cwd so future tool calls + the
 *   session header use main (Pi exposes only a readonly snapshot)
 * - rewrite the session file header cwd when the file already exists
 *
 * Worktree sessions (seeded via wt_new, carrying our custom metadata entry)
 * are never touched. Opt out with PI_WT_NO_AUTO_ESCAPE=1.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export function isAutoEscapeDisabled(): boolean {
  return process.env.PI_WT_NO_AUTO_ESCAPE === "1";
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: "pipe",
      timeout: 10_000,
      encoding: "utf-8",
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

function normalize(p: string): string {
  try {
    return resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  } catch {
    return p;
  }
}

/**
 * Resolve the main repo root for any cwd inside a repo/worktree.
 * Uses --git-common-dir (same trick as resolveGitRoot) so worktrees
 * map back to the main repo, not their own toplevel.
 */
export function resolveMainRoot(cwd: string): string | null {
  const commonDir = git(["rev-parse", "--git-common-dir"], cwd);
  if (commonDir) {
    const abs = isAbsolute(commonDir) ? commonDir : join(cwd, commonDir);
    return dirname(resolve(abs));
  }
  return git(["rev-parse", "--show-toplevel"], cwd);
}

/**
 * True when cwd is inside a linked worktree rather than the main checkout.
 * Detection order: git toplevel vs main root, then managed-dir prefix
 * (<mainRoot>/.pi/git-worktrees/<id>) as fallback when git is unavailable.
 */
export function isInsideWorktree(cwd: string, mainRoot: string): boolean {
  const normCwd = normalize(cwd);
  const normMain = normalize(mainRoot);
  if (normCwd === normMain) return false;

  const toplevel = git(["rev-parse", "--show-toplevel"], cwd);
  if (toplevel) {
    return normalize(toplevel) !== normMain;
  }

  const managedPrefix = normalize(join(mainRoot, ".pi", "git-worktrees") + "/");
  return normCwd.startsWith(managedPrefix);
}

/**
 * Redirect a fresh session to the main repo root. Returns true when an
 * escape happened. Never throws — failures are silent by design (best effort
 * on session_start; Pi must keep booting even if we can't redirect).
 */
export function escapeSessionToMain(
  ctx: ExtensionContext,
  mainRoot: string,
): boolean {
  if (isAutoEscapeDisabled()) return false;
  if (!isInsideWorktree(ctx.cwd, mainRoot)) return false;

  const from = ctx.cwd;

  // 1. Process cwd — affects relative fs resolution + child processes.
  try {
    process.chdir(mainRoot);
  } catch (_e) {
    void _e; // best-effort: in-memory + file patches may still succeed
  }

  // 2. In-memory SessionManager cwd — this is what tools use
  // (sessionManager.getCwd()). The public type is readonly, so patch
  // through known private field names. Field is `cwd` in current Pi.
  try {
    // SAFETY: readonly snapshot type hides runtime `cwd` string field
    // (verified in pi-coding-agent session-manager.js getCwd); guarded by typeof.
    const sm = ctx.sessionManager as unknown as Record<string, unknown>;
    if (typeof sm["cwd"] === "string") sm["cwd"] = mainRoot;
    // Defensive: some builds alias it.
    if (typeof sm["_cwd"] === "string") sm["_cwd"] = mainRoot;
  } catch (_e) {
    void _e; // best-effort redirect; Pi must keep booting
  }

  // 3. Session file header — rewrite cwd so resume keeps pointing at main.
  try {
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (sessionFile && existsSync(sessionFile)) {
      const raw = readFileSync(sessionFile, "utf-8");
      const nl = raw.indexOf("\n");
      const firstLine = nl === -1 ? raw : raw.slice(0, nl);
      const rest = nl === -1 ? "" : raw.slice(nl + 1);
      try {
        const header = JSON.parse(firstLine);
        if (header && header.type === "session" && header.cwd !== mainRoot) {
          header.cwd = mainRoot;
          writeFileSync(sessionFile, JSON.stringify(header) + "\n" + rest, "utf-8");
        }
      } catch (_inner) {
        void _inner; // malformed header — leave file alone
      }
    }
  } catch (_e) {
    void _e; // best-effort header rewrite; session still boots from in-memory cwd
  }

  try {
    ctx.ui.notify?.(`Escaped worktree → main (${mainRoot}). Started fresh from ${from}.`, "info");
  } catch (_notify) {
    void _notify; // headless modes have no UI; escape already applied
  }
  return true;
}
