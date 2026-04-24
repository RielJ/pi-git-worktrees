/**
 * Context sharing — extract and compact worktree session content.
 *
 * Reads a worktree's session file, extracts key information,
 * and optionally compacts it via pi-vcc. Falls back to a
 * structured summary if pi-vcc is unavailable.
 */

import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { WorktreeRecord } from "./types.js";

/**
 * Extract compacted context from a worktree's session file.
 * Returns a markdown summary suitable for injection into the main session.
 */
export async function extractWorktreeContext(
  record: WorktreeRecord,
  contextDir: string,
): Promise<{ summary: string; summaryFile: string }> {
  if (!record.sessionFile) {
    throw new Error(`Worktree ${record.id} has no session file`);
  }

  // Read the session JSONL
  let rawEntries: string;
  try {
    rawEntries = readFileSync(record.sessionFile, "utf-8");
  } catch {
    throw new Error(`Cannot read session file: ${record.sessionFile}`);
  }

  // Extract key information from session entries
  const extracted = extractFromSession(rawEntries, record);

  // Try pi-vcc compaction first
  let summary: string;
  const vccAvailable = await checkVccAvailable();

  if (vccAvailable) {
    try {
      summary = await compactWithVcc(extracted);
    } catch {
      // Fall back to structured summary
      summary = extracted;
    }
  } else {
    summary = extracted;
  }

  // Save to file
  mkdirSync(join(contextDir, "context"), { recursive: true });
  const summaryFile = join(contextDir, "context", `${record.id}.md`);
  writeFileSync(summaryFile, summary, "utf-8");

  return { summary, summaryFile };
}

/**
 * Extract key information from a session JSONL file.
 */
function extractFromSession(rawJsonl: string, record: WorktreeRecord): string {
  const lines = rawJsonl.split("\n").filter((l) => l.trim());
  const messages: Array<{ role: string; text: string }> = [];
  const filesModified = new Set<string>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Extract user/assistant messages
      if (entry.type === "message" || entry.role) {
        const role = entry.role || entry.type;
        const content = entry.content;
        if (typeof content === "string") {
          messages.push({ role, text: content });
        } else if (Array.isArray(content)) {
          const text = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
          if (text) messages.push({ role, text });
        }
      }

      // Track file modifications from tool calls
      if (entry.type === "tool_use" || entry.type === "tool_call") {
        const input = entry.input || entry.args || {};
        if (input.path) filesModified.add(input.path);
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Build structured summary
  const parts: string[] = [
    `## Worktree Context: ${record.id}`,
    "",
    `**Task:** ${record.task}`,
    `**Branch:** ${record.targetBranch || record.branch}`,
    `**Status:** ${record.status}`,
  ];

  if (filesModified.size > 0) {
    parts.push(`**Files Modified:** ${[...filesModified].join(", ")}`);
  }

  parts.push("");

  // Include last few assistant messages as summary
  const assistantMsgs = messages.filter((m) => m.role === "assistant");
  if (assistantMsgs.length > 0) {
    const last = assistantMsgs.slice(-3);
    parts.push("### Agent Summary");
    for (const msg of last) {
      parts.push(msg.text.slice(0, 500));
      parts.push("");
    }
  }

  return parts.join("\n");
}

/**
 * Check if pi-vcc (vcc_recall) is available.
 */
async function checkVccAvailable(): Promise<boolean> {
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("which", ["pi-vcc"], { encoding: "utf-8", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compact text using pi-vcc.
 */
async function compactWithVcc(text: string): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("pi-vcc", ["compact", "--stdin"], {
    input: text,
    encoding: "utf-8",
    timeout: 30_000,
  });
}
