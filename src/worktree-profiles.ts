/**
 * Extension profiles for worktrees.
 *
 * Each profile defines a curated set of tools/extensions for a specific
 * purpose. When a worktree is created, a .pi/settings.json is written
 * into the worktree directory to limit extensions.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import type { ExtensionProfile } from "./types.js";

// ── Profile definitions ─────────────────────────────────────────────

/**
 * Core tools that are always available in every profile.
 */
const CORE_TOOLS = ["read", "bash", "write", "edit", "grep", "find", "multi_grep"];

/**
 * Tools added per profile on top of core.
 */
const PROFILE_TOOLS: Record<ExtensionProfile, string[]> = {
  minimal: [],
  coding: ["wt_new", "wt_context"],
  review: ["wt_context"],
  research: ["web_search", "web_read", "qmd_search", "qmd_query"],
};

/**
 * Extensions to KEEP per profile. Everything else is disabled.
 * These are extension names/paths that match the Pi settings format.
 */
const PROFILE_EXTENSIONS: Record<ExtensionProfile, string[]> = {
  minimal: [],
  coding: [],
  review: [],
  research: [],
};

/**
 * Get the full list of enabled tools for a profile.
 */
export function getProfileTools(profile: ExtensionProfile): string[] {
  return [...CORE_TOOLS, ...(PROFILE_TOOLS[profile] || [])];
}

/**
 * Write profile metadata into the worktree directory.
 * 
 * NOTE: We do NOT write .pi/agent/settings.json here because Pi
 * reads per-project settings on session switch. Writing `extensions: []`
 * would disable all extensions (including this one) and freeze Pi.
 * 
 * Extension filtering is handled at the tool level via the registry's
 * `extensionProfile` field, checked during `session_start`.
 */
export function writeWorktreeProfile(
  _worktreePath: string,
  _profile: ExtensionProfile,
): void {
  // Intentionally a no-op for now.
  // Future: could write an AGENTS.md with profile-specific instructions.
}

/**
 * Clean up profile artifacts from a worktree directory.
 */
export function cleanupWorktreeProfile(worktreePath: string): void {
  try {
    const piDir = join(worktreePath, ".pi");
    rmSync(piDir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

/**
 * Infer a profile from a task description.
 */
export function inferProfile(task: string): ExtensionProfile {
  const lower = task.toLowerCase();
  if (lower.includes("review") || lower.includes("audit") || lower.includes("check")) {
    return "review";
  }
  if (lower.includes("research") || lower.includes("explore") || lower.includes("investigate")) {
    return "research";
  }
  if (lower.includes("plan") || lower.includes("design") || lower.includes("architecture")) {
    return "research";
  }
  return "coding";
}
