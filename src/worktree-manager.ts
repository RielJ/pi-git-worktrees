/**
 * WorktreeManager — Git worktree lifecycle management
 *
 * Creates/removes git worktrees, tracks state in .pi/wt-agents/registry.json.
 * Uses file-lock based concurrency for safe multi-process access.
 */

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { promises as fs, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute as isAbsolutePath, join, resolve } from "node:path";
import type { WorktreeRecord, WorktreeRegistry, WorktreeStatus } from "./types.js";

const REGISTRY_VERSION = 1;

// ── Helpers ─────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

function git(args: string[], opts?: { cwd?: string }): string {
  const execOpts: ExecFileSyncOptions = {
    cwd: opts?.cwd,
    stdio: "pipe",
    timeout: 15_000,
    encoding: "utf-8" as BufferEncoding,
  };
  return execFileSync("git", args, execOpts).toString().trim();
}

function gitSafe(args: string[], opts?: { cwd?: string }): string | null {
  try {
    return git(args, opts);
  } catch {
    return null;
  }
}

// ── Slug Generation ─────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "in", "on", "at", "of", "for",
  "and", "or", "is", "it", "be", "do", "with", "this", "that",
]);

export function slugFromTask(task: string): string {
  const words = task
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
  return words.slice(0, 3).join("-") || "worktree";
}

function deduplicateSlug(slug: string, existing: Set<string>): string {
  if (!existing.has(slug)) return slug;
  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

// ── Registry Persistence ────────────────────────────────────────────

function emptyRegistry(): WorktreeRegistry {
  return { version: REGISTRY_VERSION, worktrees: {} };
}

export class WorktreeManager {
  private metaDir: string;
  private registryPath: string;
  private lockPath: string;

  constructor(private repoRoot: string) {
    this.metaDir = join(repoRoot, ".pi", "git-worktrees");
    this.registryPath = join(this.metaDir, "registry.json");
    this.lockPath = join(this.metaDir, "registry.lock");
  }

  get root(): string {
    return this.repoRoot;
  }

  // ── Registry I/O ────────────────────────────────────────────────

  async loadRegistry(): Promise<WorktreeRegistry> {
    try {
      const raw = await fs.readFile(this.registryPath, "utf-8");
      const parsed = JSON.parse(raw) as WorktreeRegistry;
      if (parsed.version === REGISTRY_VERSION && typeof parsed.worktrees === "object") {
        return parsed;
      }
    } catch {}
    return emptyRegistry();
  }

  async saveRegistry(registry: WorktreeRegistry): Promise<void> {
    await ensureDir(this.metaDir);
    const tmp = `${this.registryPath}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(registry, null, 2) + "\n", "utf-8");
    await fs.rename(tmp, this.registryPath);
  }

  async withLock<T>(fn: (registry: WorktreeRegistry) => Promise<T>): Promise<T> {
    await ensureDir(dirname(this.lockPath));
    const started = Date.now();

    while (true) {
      try {
        const handle = await fs.open(this.lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowIso() }), "utf-8");
          const registry = await this.loadRegistry();
          const result = await fn(registry);
          await this.saveRegistry(registry);
          return result;
        } finally {
          await handle.close().catch(() => {});
          await fs.unlink(this.lockPath).catch(() => {});
        }
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;

        // Stale lock check
        try {
          const st = await fs.stat(this.lockPath);
          if (Date.now() - st.mtimeMs > 15_000) {
            await fs.unlink(this.lockPath).catch(() => {});
            continue;
          }
        } catch {}

        if (Date.now() - started > 10_000) {
          throw new Error("Timed out waiting for registry lock");
        }
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      }
    }
  }

  getMetaDir(): string {
    return this.metaDir;
  }

  getRepoRoot(): string {
    return this.repoRoot;
  }

  // ── Worktree CRUD ───────────────────────────────────────────────

  /**
   * Allocate a new git worktree for an agent.
   * Creates the worktree inside .pi/git-worktrees/ with the given branch name.
   * If no branch is provided, one is derived from the task description.
   */
  async allocate(task: string, opts?: { slug?: string; branch?: string }): Promise<WorktreeRecord> {
    const finalSlug = await this.withLock(async (registry) => {
      const existing = new Set(Object.keys(registry.worktrees));
      const base = opts?.slug || slugFromTask(task);
      return deduplicateSlug(base, existing);
    });

    const targetBranch = opts?.branch || finalSlug;
    const internalBranch = `_wt/${targetBranch}`;
    const worktreePath = join(this.metaDir, finalSlug);
    const mainHead = git(["rev-parse", "HEAD"], { cwd: this.repoRoot });

    // Ensure .pi/git-worktrees/ exists
    mkdirSync(this.metaDir, { recursive: true });

    // Create the worktree with internal branch — user can freely checkout targetBranch
    git(["worktree", "add", "-B", internalBranch, worktreePath, mainHead], { cwd: this.repoRoot });

    const now = nowIso();
    const record: WorktreeRecord = {
      id: finalSlug,
      worktreePath: resolve(worktreePath),
      branch: internalBranch,
      targetBranch,
      status: "ready",
      task,
      createdAt: now,
      updatedAt: now,
      toolUses: 0,
      turnCount: 0,
      activity: "",
    };

    await this.withLock(async (registry) => {
      registry.worktrees[finalSlug] = record;
    });

    return record;
  }

  /**
   * Remove a worktree and clean up its branch.
   */
  async remove(id: string): Promise<void> {
    const registry = await this.loadRegistry();
    const record = registry.worktrees[id];
    if (!record) return;

    // Thorough cleanup: git worktree, branch, session, context, directory
    await this.destroyWorktreeFiles(record);

    // Remove from registry
    await this.withLock(async (reg) => {
      delete reg.worktrees[id];
    });
  }

  /**
   * List all tracked worktrees.
   */
  async list(): Promise<WorktreeRecord[]> {
    const registry = await this.loadRegistry();
    return Object.values(registry.worktrees).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt),
    );
  }

  /**
   * Update a worktree record's status and activity.
   */
  async update(
    id: string,
    patch: Partial<Pick<WorktreeRecord,
      | "status" | "activity" | "toolUses" | "turnCount" | "model"
      | "sessionFile" | "archived" | "archivedAt"
      | "purpose" | "extensionProfile" | "enabledTools"
      | "contextSummaryFile" | "lastContextCompactedAt"
    >>,
  ): Promise<void> {
    await this.withLock(async (registry) => {
      const record = registry.worktrees[id];
      if (!record) return;
      Object.assign(record, patch, { updatedAt: nowIso() });
    });
  }

  /**
   * Get a single worktree record.
   */
  async get(id: string): Promise<WorktreeRecord | undefined> {
    const registry = await this.loadRegistry();
    return registry.worktrees[id];
  }

  /**
   * Detect existing git worktrees in this repo (including ones not created by us).
   */
  async detectExisting(): Promise<Array<{ path: string; branch: string }>> {
    return listGitWorktrees(this.repoRoot);
  }

  /**
   * Reconcile registry with what's actually on disk.
   * Scans .pi/git-worktrees/ for subdirectories and cross-references
   * with the registry and `git worktree list`.
   * - Directories on disk but not in registry → add them
   * - Registry entries with no directory on disk → remove stale entries
   */
  async reconcile(): Promise<void> {
    // Scan .pi/git-worktrees/ for subdirectories (the actual worktrees)
    const dirsOnDisk = new Set<string>();
    try {
      for (const entry of readdirSync(this.metaDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          dirsOnDisk.add(entry.name);
        }
      }
    } catch {
      // metaDir doesn't exist yet
      return;
    }

    // Also verify with git
    const gitWorktrees = await this.detectExisting();
    const gitPaths = new Set(gitWorktrees.map((w) => w.path));

    await this.withLock(async (registry) => {
      // Remove stale registry entries (directory was deleted or git worktree removed)
      for (const id of Object.keys(registry.worktrees)) {
        const record = registry.worktrees[id];
        if (!dirsOnDisk.has(id) || !gitPaths.has(record.worktreePath)) {
          delete registry.worktrees[id];
        }
      }

      // Add directories on disk that are missing from registry
      const registeredIds = new Set(Object.keys(registry.worktrees));
      for (const dirName of dirsOnDisk) {
        if (registeredIds.has(dirName)) continue;
        const dirPath = join(this.metaDir, dirName);
        // Verify it's actually a git worktree (has a .git file)
        try {
          statSync(join(dirPath, ".git"));
        } catch {
          continue; // Not a worktree, skip
        }

        const now = nowIso();
        registry.worktrees[dirName] = {
          id: dirName,
          worktreePath: dirPath,
          branch: `_wt/${dirName}`,
          targetBranch: dirName,
          status: "idle",
          task: "(restored from disk)",
          createdAt: now,
          updatedAt: now,
          toolUses: 0,
          turnCount: 0,
          activity: "restored",
        };
      }
    });
  }

  // ── Session helpers ───────────────────────────────────────────

  /**
   * Set the session file path for a worktree.
   */
  async setSessionFile(id: string, sessionFile: string): Promise<void> {
    await this.update(id, { sessionFile });
  }

  /**
   * Archive a worktree (mark as merged/removed but keep session history).
   */
  async archive(id: string): Promise<void> {
    await this.withLock(async (registry) => {
      const record = registry.worktrees[id];
      if (record) {
        record.archived = true;
        record.archivedAt = nowIso();
        record.status = "done";
        record.updatedAt = nowIso();
      }
    });
  }

  /**
   * Get the persisted main session file path.
   */
  async getMainSessionFile(): Promise<string | undefined> {
    const registry = await this.loadRegistry();
    return registry.mainSessionFile;
  }

  /**
   * Persist the main session file path in the registry.
   */
  async setMainSessionFile(sessionFile: string): Promise<void> {
    await this.withLock(async (registry) => {
      registry.mainSessionFile = sessionFile;
    });
  }

  /**
   * Get all non-archived worktree records.
   */
  async getActive(): Promise<WorktreeRecord[]> {
    const all = await this.list();
    return all.filter((r) => !r.archived);
  }

  /**
   * Merge a worktree's branch back into the current branch.
   */
  async merge(id: string): Promise<{ ok: boolean; message: string }> {
    const record = await this.get(id);
    if (!record) return { ok: false, message: `Unknown worktree: ${id}` };

    // Commit any uncommitted changes in the worktree
    const status = gitSafe(["status", "--porcelain"], { cwd: record.worktreePath });
    if (status && status.trim()) {
      gitSafe(["add", "-A"], { cwd: record.worktreePath });
      gitSafe(["commit", "-m", `wt-agent: ${record.task.slice(0, 100)}`], { cwd: record.worktreePath });
    }

    // Merge into main repo
    try {
      git(["merge", record.branch, "--no-edit"], { cwd: this.repoRoot });
    } catch (err: any) {
      return { ok: false, message: `Merge conflict: ${err.message?.slice(0, 200)}` };
    }

    // Remove git worktree + directory, but keep registry entry for archival
    await this.destroyWorktreeFiles(record);

    const displayBranch = record.targetBranch || record.branch;
    return { ok: true, message: `Merged ${displayBranch} and cleaned up` };
  }

  /**
   * Remove git worktree files, branch, and session artifacts.
   * Does NOT touch the registry — call remove() or archive() for that.
   */
  private async destroyWorktreeFiles(record: WorktreeRecord): Promise<void> {
    // 1. Git worktree remove
    gitSafe(["worktree", "remove", "--force", record.worktreePath], { cwd: this.repoRoot });

    // 2. Force-remove directory if git left anything behind
    try {
      const stat = statSync(record.worktreePath);
      if (stat) {
        const { rmSync } = await import("node:fs");
        rmSync(record.worktreePath, { recursive: true, force: true });
      }
    } catch {}

    // 3. Delete session file
    if (record.sessionFile) {
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(record.sessionFile);
      } catch {}
    }

    // 4. Delete context summary file
    if (record.contextSummaryFile) {
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(record.contextSummaryFile);
      } catch {}
    }

    // 5. Delete branch
    gitSafe(["branch", "-D", record.branch], { cwd: this.repoRoot });

    // 6. Prune stale worktree references
    gitSafe(["worktree", "prune"], { cwd: this.repoRoot });
  }
}

/**
 * List all git worktrees (excluding the main one) via `git worktree list --porcelain`.
 */
function listGitWorktrees(repoRoot: string): Array<{ path: string; branch: string }> {
  const output = gitSafe(["worktree", "list", "--porcelain"], { cwd: repoRoot });
  if (!output) return [];

  const worktrees: Array<{ path: string; branch: string }> = [];
  let currentPath = "";
  let currentBranch = "";

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath && currentPath !== repoRoot) {
        worktrees.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = line.slice("worktree ".length).trim();
      currentBranch = "";
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      currentBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  if (currentPath && currentPath !== repoRoot) {
    worktrees.push({ path: currentPath, branch: currentBranch });
  }

  return worktrees;
}

/**
 * Resolve the git root for a given cwd.
 */
/**
 * Resolve the git root for the given cwd.
 * For worktrees, returns the MAIN repo root (not the worktree root)
 * so we always find the same registry.
 */
export function resolveGitRoot(cwd: string): string | null {
  // First try: get the common git dir (works in both main and worktree)
  const commonDir = gitSafe(["rev-parse", "--git-common-dir"], { cwd });
  if (commonDir) {
    // commonDir is e.g. "/path/to/main-repo/.git"
    // The repo root is its parent
    const absCommonDir = isAbsolutePath(commonDir) ? commonDir : join(cwd, commonDir);
    return dirname(absCommonDir);
  }
  // Fallback: standard toplevel
  return gitSafe(["rev-parse", "--show-toplevel"], { cwd });
}
