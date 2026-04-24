/**
 * Shared types for pi-git-worktrees
 */

// ── Registry ────────────────────────────────────────────────────────

export interface WorktreeRegistry {
  version: 1;
  /** Path to the main Pi session file — persisted so "switch back" works after reload */
  mainSessionFile?: string;
  /** User-configurable defaults */
  settings?: WorktreeSettings;
  worktrees: Record<string, WorktreeRecord>;
}

export interface WorktreeSettings {
  autoSwitchOnCreate: boolean;
  showWidget: boolean;
  defaultProfile: ExtensionProfile;
  maxWorktrees: number;
}

export interface WorktreeRecord {
  /** Unique slug, e.g. "fix-auth" */
  id: string;
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Internal git branch name used by the worktree, e.g. "_wt/feat/fix-auth" */
  branch: string;
  /** User-facing target branch name, e.g. "feat/fix-auth". The user can freely checkout this branch. */
  targetBranch?: string;
  /** Agent lifecycle status */
  status: WorktreeStatus;
  /** Original task description */
  task: string;
  /** Model used for the agent */
  model?: string;
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp */
  updatedAt: string;

  // ── Session ──
  /** Path to the Pi session JSONL file */
  sessionFile?: string;
  /** Whether this worktree has been merged/archived (history preserved) */
  archived?: boolean;
  /** ISO timestamp when archived */
  archivedAt?: string;

  // ── Purpose & Extensions ──
  /** Short purpose classification (inferred or explicit) */
  purpose?: string;
  /** Extension profile for this worktree */
  extensionProfile?: ExtensionProfile;
  /** Specific tools to enable (null = all) */
  enabledTools?: string[] | null;

  // ── Context sharing ──
  /** Path to compacted context summary file */
  contextSummaryFile?: string;
  /** ISO timestamp when context was last compacted */
  lastContextCompactedAt?: string;

  // ── Agent state ──
  /** Number of tools the agent has used */
  toolUses: number;
  /** Current turn count */
  turnCount: number;
  /** Current activity summary text */
  activity: string;
}

export type WorktreeStatus =
  | "creating"
  | "ready"
  | "running"
  | "idle"
  | "done"
  | "failed";

export type ExtensionProfile =
  | "minimal"   // core tools only: read, bash, write, edit, grep, find
  | "coding"    // + git helpers, worktree tools
  | "review"    // + diff/review helpers
  | "research"; // + docs/search

// ── Widget ──────────────────────────────────────────────────────────

export interface WorktreeBoxData {
  id: string;
  name: string;
  branch: string;
  status: WorktreeStatus;
  summary: string;
  isActive: boolean;
}
