/**
 * pi-git-worktrees — Git worktree-based parallel agent sessions
 *
 * Each worktree gets its own Pi session running in a hidden tmux session.
 * Viewing a worktree opens a floating popup overlay (tmux display-popup).
 * Dismissing the popup returns to main — the worktree Pi keeps running.
 *
 * Architecture:
 *
 *   tmux
 *   ├── your pane (main Pi) ← never touched
 *   │
 *   └── hidden sessions (auto-managed)
 *       ├── _pi-wt-fix-auth   ← Pi running, invisible
 *       ├── _pi-wt-refactor   ← Pi running, invisible
 *       └── ...
 *
 *   /wt-switch fix-auth → display-popup attaches to _pi-wt-fix-auth
 *   dismiss popup       → back to main, worktree keeps running
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { fileURLToPath } from "node:url";
import { WorktreeManager, resolveGitRoot } from "./worktree-manager.js";
import { WorktreeSessionManager, detectWorktreeSession } from "./worktree-session.js";
import { escapeSessionToMain } from "./auto-escape.js";
import { WorktreeWidget } from "./worktree-widget.js";
import { showWorktreesPanel, type PanelActionHandlers } from "./worktrees-panel.js";
import type { WorktreeBoxData, WorktreeRecord } from "./types.js";
import { extractWorktreeContext } from "./worktree-context.js";
import { inferProfile, writeWorktreeProfile } from "./worktree-profiles.js";
import type { ExtensionProfile } from "./types.js";
import * as heartbeat from "./heartbeat.js";
import {
  inTmux,
  signalReady,
  spawnWorktreeSession,
  openPopup,
  killWorktreeSession,
  isSessionAlive,
  sendKeysToSession,
} from "./tmux-swap.js";

/** Path to this extension file — used so spawned Pi loads the same extension */
const SELF = fileURLToPath(import.meta.url);

// ── State ───────────────────────────────────────────────────────────

let manager: WorktreeManager | null = null;
let wtSessionMgr: WorktreeSessionManager | null = null;
let widget: WorktreeWidget | null = null;
let currentCtx: ExtensionContext | null = null;
let activeWorktreeId: string | null = null; // null = main
let mainSessionPath: string | null = null;
/** Cached registry records for getBoxData() */
let cachedRegistryRecords: import("./types.js").WorktreeRecord[] = [];
/** Periodic timer to poll worktree statuses */
let statusPollInterval: ReturnType<typeof setInterval> | null = null;

async function refreshRegistryCache(): Promise<void> {
  if (!manager) return;
  try {
    cachedRegistryRecords = await manager.getActive();
  } catch {
    cachedRegistryRecords = [];
  }
}

// ── Box Data Provider ───────────────────────────────────────────────
// Merges registry data with live tmux session data for real-time status.

function getBoxData(): WorktreeBoxData[] {
  if (!manager) return [];

  const boxes: WorktreeBoxData[] = [];

  // Main worktree (always first)
  boxes.push({
    id: "main",
    name: "main",
    branch: "main",
    status: "idle",
    summary: activeWorktreeId === null ? "active" : "background",
    isActive: activeWorktreeId === null,
  });

  // Worktrees from registry, enriched with live session status
  for (const record of cachedRegistryRecords) {
    const alive = inTmux() && isSessionAlive(record.id);
    let status = record.status;
    let summary = record.activity || "\u2014";

    if (alive) {
      // Session is running — check heartbeat for busy state
      const hb = heartbeat.findByWorktreeId(record.id);
      const isBusy = hb?.busy ?? false;
      status = isBusy ? "running" : "idle";
      summary = hb?.activity || (isBusy ? "thinking\u2026" : "waiting for input");
    } else if (status === "running") {
      // Was running but session is dead
      status = "done";
      summary = "session ended";
    }

    boxes.push({
      id: record.id,
      name: record.id,
      branch: record.targetBranch || record.branch,
      status,
      summary,
      isActive: activeWorktreeId === record.id,
    });
  }

  return boxes;
}

// ── Extension ───────────────────────────────────────────────────────

export default function piGitWorktrees(pi: ExtensionAPI) {
  // ── Cleanup on shutdown ─────────────────────────────────────────

  function onShutdown(): void {
    heartbeat.stop();
    if (statusPollInterval) {
      clearInterval(statusPollInterval);
      statusPollInterval = null;
    }
  }

  /** Start polling worktree statuses every 3s so the widget stays current */
  function startStatusPoller(): void {
    if (statusPollInterval) return; // already running
    const tick = setInterval(async () => {
      if (!manager || cachedRegistryRecords.length === 0) return;
      await refreshRegistryCache();
      widget?.refresh();
    }, 3000);
    if (typeof tick.unref === "function") tick.unref();
    statusPollInterval = tick;
  }

  function stopStatusPoller(): void {
    if (statusPollInterval) {
      clearInterval(statusPollInterval);
      statusPollInterval = null;
    }
  }

  process.once("exit", onShutdown);
  for (const sig of ["SIGHUP", "SIGTERM"] as const) {
    process.once(sig, () => {
      onShutdown();
      process.exit(0);
    });
  }

  // ── Lifecycle — session_start ─────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    try {
      currentCtx = ctx;

      const gitRoot = resolveGitRoot(ctx.cwd);
      if (!gitRoot) return;

      // Fresh /new or new-terminal sessions started inside a worktree
      // inherit the worktree directory. Bounce them to main instead.
      // Worktree sessions (wt_new metadata) are never touched.
      if (event.reason === "startup" || event.reason === "new") {
        try {
          if (!detectWorktreeSession(ctx)) escapeSessionToMain(ctx, gitRoot);
        } catch (_e) {
          void _e; // best-effort redirect; continue normal startup
        }
      }

      // Re-create managers if git root changed or on first load
      if (!manager || manager.getRepoRoot() !== gitRoot) {
        manager = new WorktreeManager(gitRoot);
        wtSessionMgr = new WorktreeSessionManager(gitRoot);
      }
      if (!widget) {
        widget = new WorktreeWidget(getBoxData);
      }

      // Start heartbeat for this Pi process
      if (inTmux()) {
        const pane = process.env.TMUX_PANE!;
        const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "";

        // Detect if this session is a worktree session
        const wtMeta = detectWorktreeSession(ctx);

        heartbeat.stop(); // Stop any previous heartbeat
        heartbeat.start({
          paneId: pane,
          sessionFile,
          cwd: ctx.cwd,
          pid: process.pid,
          owner: pane,
          busy: false,
          worktreeId: wtMeta?.worktreeId,
          branch: wtMeta?.branch,
          parentSessionFile: wtMeta?.mainSessionPath,
        });

        if (wtMeta) {
          activeWorktreeId = wtMeta.worktreeId;
          mainSessionPath = wtMeta.mainSessionPath;
        } else {
          activeWorktreeId = null;
          const sessionFilePath = ctx.sessionManager.getSessionFile?.() ?? null;
          if (sessionFilePath) {
            mainSessionPath = sessionFilePath;
            await manager.setMainSessionFile(sessionFilePath).catch(() => {});
          } else {
            mainSessionPath = await manager.getMainSessionFile().catch(() => undefined) ?? null;
          }
        }
      } else {
        // Not in tmux
        const wtMeta = detectWorktreeSession(ctx);
        if (wtMeta) {
          activeWorktreeId = wtMeta.worktreeId;
          mainSessionPath = wtMeta.mainSessionPath;
        } else {
          activeWorktreeId = null;
          const sf = ctx.sessionManager.getSessionFile?.() ?? null;
          if (sf) {
            mainSessionPath = sf;
            await manager.setMainSessionFile(sf).catch(() => {});
          }
        }
      }

      // Signal ready (if spawned by spawnWorktreeSession)
      signalReady();

      await manager.reconcile().catch(() => {});
      await refreshRegistryCache();
      syncWidgetVisibility(ctx);
      widget?.refresh();

      // Start polling if there are active worktrees
      if (cachedRegistryRecords.length > 0) {
        startStatusPoller();
      } else {
        stopStatusPoller();
      }
    } catch (err: any) {
      console.error(`[pi-git-worktrees] session_start error: ${err.message}`);
    }
  });

  // ── System prompt injection ─────────────────────────────────────

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!manager) return {};

    const worktreeInfo = activeWorktreeId
      ? `\n\nYou are currently in worktree "${activeWorktreeId}". Your cwd is the worktree, not the main repo.`
      : "";

    const instructions = [
      "",
      "## Git Worktree Agents (pi-git-worktrees extension)",
      "",
      "You have tools for managing isolated git worktree agents:",
      "- `wt_new`: Create a new worktree with its own Pi session",
      "- `wt_context`: Retrieve compacted context from a spawned worktree's session",
      "- `wt_send`: Send a message/instruction to a running worktree agent",
      "- `wt_wait`: Wait for one or all worktrees to finish their current task",
      "- `wt_gather`: Collect and compile context from all worktrees into a report",
      "",
      "NEVER use raw `git worktree add/remove` shell commands.",
      "Always use the tools directly.",
      "",
      "When calling `wt_new`, always provide a descriptive `branch` name.",
      "Use conventional branch naming: feat/, fix/, refactor/, chore/, etc.",
      "",
      "Use `wt_context` when the user asks about what happened in another worktree,",
      "or when you need cross-worktree context for merging decisions.",
      "",
      "### Orchestration Pattern (fan-out / wait / gather)",
      "",
      "To dispatch work and collect results:",
      "1. `wt_new` or `wt_send` \u2014 dispatch tasks to worktrees",
      "2. `wt_wait` \u2014 wait for all (or specific) worktrees to finish",
      "3. `wt_gather` \u2014 collect compiled results from all worktrees",
      "",
      "Example: spawn 3 worktrees, wait for all, then synthesize:",
      "```",
      "wt_new(\"fix auth\") \u2192 wt_new(\"add tests\") \u2192 wt_new(\"update docs\")",
      "wt_wait() \u2192 wt_gather() \u2192 synthesize results",
      "```",
      worktreeInfo,
    ].join("\n");

    return { systemPrompt: event.systemPrompt + instructions };
  });

  // ── Live status tracking via heartbeat ──────────────────────────

  pi.on("turn_start" as any, async () => {
    heartbeat.setBusy(true);
    if (activeWorktreeId && manager) {
      await manager.update(activeWorktreeId, { status: "running", activity: "thinking\u2026" }).catch(() => {});
      await refreshRegistryCache();
      widget?.refresh();
    }
  });

  pi.on("turn_end" as any, async () => {
    heartbeat.setBusy(false);
    if (activeWorktreeId && manager) {
      await manager.update(activeWorktreeId, { status: "idle", activity: "waiting for input" }).catch(() => {});
      await refreshRegistryCache();
      widget?.refresh();
    }
  });

  pi.on("agent_end" as any, async () => {
    heartbeat.setBusy(false);
    if (activeWorktreeId && manager) {
      await manager.update(activeWorktreeId, { status: "idle", activity: "waiting for input" }).catch(() => {});
      await refreshRegistryCache();
      widget?.refresh();
    }
  });

  pi.on("tool_execution_start" as any, async (event: any) => {
    const activity = describeToolActivity(event.toolName || event.name, event.args || event.input);
    heartbeat.setActivity(activity);
    if (activeWorktreeId && manager) {
      await manager.update(activeWorktreeId, { activity }).catch(() => {});
      await refreshRegistryCache();
      widget?.refresh();
    }
  });

  pi.on("session_shutdown", async () => {
    heartbeat.stop();
    widget = null;
    manager = null;
    wtSessionMgr = null;
    activeWorktreeId = null;
    mainSessionPath = null;
    cachedRegistryRecords = [];
  });

  // ── Core: create a worktree + spawn Pi in hidden session ──────

  async function createWorktree(
    opts: { task: string; planPath?: string; model?: string; branch?: string; profile?: ExtensionProfile },
    ctx: ExtensionContext,
  ): Promise<{ ok: true; id: string; worktreePath: string; sessionFile: string } | { ok: false; error: string }> {
    if (!manager || !wtSessionMgr) {
      return { ok: false, error: "Not in a git repository" };
    }

    let { task, planPath, model } = opts;

    if (planPath && !task) {
      task = `Execute the plan at ${planPath}. Read it first, then implement each section step by step.`;
    }
    if (!task) {
      return { ok: false, error: "No task provided" };
    }

    try {
      // 1. Allocate git worktree
      const record = await manager.allocate(task, { branch: opts.branch });
      await manager.update(record.id, { model, status: "ready" });

      // 2. Apply extension profile
      const profile = opts.profile || inferProfile(task);
      writeWorktreeProfile(record.worktreePath, profile);
      await manager.update(record.id, { extensionProfile: profile, purpose: profile });

      // 3. Copy plan file into worktree if --plan
      if (planPath) {
        const fs = await import("node:fs");
        const nodePath = await import("node:path");
        const absSource = nodePath.resolve(ctx.cwd, planPath);
        const destDir = nodePath.join(record.worktreePath, nodePath.dirname(planPath));
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(absSource, nodePath.join(record.worktreePath, planPath));
      }

      // 4. Create Pi session file
      const currentSessionFile = mainSessionPath
        || ctx.sessionManager?.getSessionFile?.()
        || "unknown";

      const { sessionFile } = wtSessionMgr.createSession({
        worktreeId: record.id,
        worktreePath: record.worktreePath,
        task,
        branch: record.branch,
        mainSessionPath: currentSessionFile,
      });

      await manager.setSessionFile(record.id, sessionFile);

      // 5. Spawn Pi in a hidden tmux session
      if (inTmux()) {
        const piCmd = `pi -e ${SELF} --session ${sessionFile}`;
        const ok = spawnWorktreeSession(record.id, piCmd, record.worktreePath);
        if (ok) {
          // Pi is running and ready. Send the task as user input.
          sendKeysToSession(record.id, task);
        }
      } else {
        // Not in tmux — fallback: spawn headless pi -p
        wtSessionMgr.spawnBackgroundAgent({
          sessionFile,
          worktreePath: record.worktreePath,
          task,
        });
      }

      await manager.update(record.id, { status: "running" });
      await refreshRegistryCache();
      syncWidgetVisibility(ctx);
      widget?.refresh();
      startStatusPoller();

      return { ok: true, id: record.id, worktreePath: record.worktreePath, sessionFile };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // ── /worktrees — Interactive tabbed dialog ────────────────────

  function buildPanelHandlers(ctx: ExtensionCommandContext): PanelActionHandlers {
    return {
      async create(task: string): Promise<string> {
        const result = await createWorktree({ task }, ctx);
        if (!result.ok) throw new Error(result.error);
        await refreshRegistryCache();
        widget?.refresh();
        return `Created ${result.id}`;
      },

      async remove(id: string): Promise<string> {
        if (!manager) throw new Error("No manager");
        // Kill the hidden tmux session
        killWorktreeSession(id);
        await manager.remove(id);
        await refreshRegistryCache();
        widget?.refresh();
        return `Removed ${id}`;
      },

      async merge(id: string): Promise<string> {
        if (!manager) throw new Error("No manager");
        const result = await manager.merge(id);
        if (!result.ok) throw new Error(result.message);
        killWorktreeSession(id);
        await manager.archive(id);
        await refreshRegistryCache();
        widget?.refresh();
        return result.message;
      },

      async context(id: string): Promise<string> {
        if (!manager) throw new Error("No manager");
        const record = await manager.get(id);
        if (!record?.sessionFile) throw new Error(`No session for ${id}`);
        const contextDir = manager.getMetaDir();
        const { summary, summaryFile } = await extractWorktreeContext(record, contextDir);
        await manager.update(id, {
          contextSummaryFile: summaryFile,
          lastContextCompactedAt: new Date().toISOString(),
        } as any);
        await refreshRegistryCache();
        pi.sendMessage({
          customType: "worktree-context",
          content: summary,
          display: true,
          details: { worktreeId: id },
        });
        return `Imported context from ${id}`;
      },

      async send(id: string, message: string): Promise<string> {
        if (!manager) throw new Error("No manager");
        if (!inTmux()) throw new Error("tmux required for messaging");
        const record = await manager.get(id);
        if (!record) throw new Error(`Unknown worktree: ${id}`);
        if (!isSessionAlive(id)) throw new Error(`Worktree "${id}" is not running`);
        sendKeysToSession(id, message);
        return `Message sent to ${id}`;
      },

      async diff(id: string): Promise<string> {
        if (!manager) throw new Error("No manager");
        const record = await manager.get(id);
        if (!record) throw new Error(`Unknown worktree: ${id}`);
        try {
          const { execFileSync: exec } = await import("node:child_process");
          const diff = exec("git", ["diff", "main..." + record.branch, "--stat"], {
            cwd: manager.getRepoRoot(),
            encoding: "utf-8",
            timeout: 10_000,
          }).trim();
          if (diff) {
            pi.sendMessage({
              customType: "worktree-diff",
              content: `## Diff: ${record.targetBranch || record.branch}\n\`\`\`\n${diff}\n\`\`\``,
              display: true,
              details: { worktreeId: id },
            });
            return `Diff shown for ${id}`;
          }
          return `No changes in ${id}`;
        } catch {
          return `No diff available for ${id}`;
        }
      },

      async cleanup(): Promise<string> {
        if (!manager) throw new Error("No manager");
        await manager.reconcile();
        await refreshRegistryCache();
        if (currentCtx) syncWidgetVisibility(currentCtx);
        widget?.refresh();
        return "Cleanup complete";
      },

      async toggleWidget(): Promise<string> {
        if (widget && currentCtx) {
          widget.toggle(currentCtx);
          return "Widget toggled";
        }
        return "No widget";
      },
    };
  }

  pi.registerCommand("worktrees", {
    description: "Open worktrees panel: browse, switch, manage, and configure worktree agents",
    handler: async (_args, ctx) => {
      if (!manager) {
        ctx.ui.notify("Not in a git repository", "error");
        return;
      }
      try {
        await refreshRegistryCache();
        const result = await showWorktreesPanel(ctx, getBoxData, buildPanelHandlers(ctx));
        if (result.type === "switch") {
          await switchToWorktree(result.worktreeId, ctx);
        }
      } catch (err: any) {
        ctx.ui.notify(`Worktrees panel error: ${err.message}`, "error");
      }
    },
  });

  // ── /wt-new — Create new worktree + session ───────────────────

  pi.registerCommand("wt-new", {
    description: [
      "Create a new worktree agent in an isolated git worktree.",
      "",
      "Usage:",
      "  /wt-new <task>                        \u2014 run a task in a new worktree",
      "  /wt-new --plan <path> [<task>]        \u2014 execute a plan file",
      "  /wt-new --branch <name> <task>        \u2014 use a specific branch name",
      "  /wt-new --model <model> <task>        \u2014 use a specific model",
    ].join("\n"),
    handler: async (args, ctx) => {
      let model: string | undefined;
      let planPath: string | undefined;
      let branch: string | undefined;
      let profile: ExtensionProfile | undefined;
      let task = args.trim();

      const modelMatch = task.match(/^--?model\s+(\S+)\s+(.*)/s);
      if (modelMatch) { model = modelMatch[1]; task = modelMatch[2].trim(); }

      const branchMatch = task.match(/^--?branch\s+(\S+)\s+(.*)/s);
      if (branchMatch) { branch = branchMatch[1]; task = branchMatch[2].trim(); }

      const profileMatch = task.match(/^--?profile\s+(\S+)\s+(.*)/s);
      if (profileMatch) { profile = profileMatch[1] as ExtensionProfile; task = profileMatch[2].trim(); }

      const planMatch = task.match(/^--?plan\s+(\S+)(?:\s+(.*))?/s);
      if (planMatch) { planPath = planMatch[1]; task = planMatch[2]?.trim() || ""; }

      if (!task && !planPath) {
        ctx.ui.notify("Usage: /wt-new [--plan <path>] [--branch <name>] [--model <model>] <task>", "warning");
        return;
      }

      if (!inTmux()) {
        ctx.ui.notify("pi-git-worktrees requires tmux for parallel sessions. Run Pi inside tmux.", "error");
        return;
      }

      ctx.ui.notify("Creating worktree agent\u2026", "info");

      const result = await createWorktree({ task, planPath, model, branch, profile }, ctx);
      if (result.ok) {
        ctx.ui.notify(
          `Worktree ${result.id} created and running. Use /wt-switch ${result.id} to view.`,
          "info",
        );
      } else {
        ctx.ui.notify(`Failed: ${result.error}`, "error");
      }
    },
  });

  // ── /wt-switch — Open worktree in floating popup ──────────────

  pi.registerCommand("wt-switch", {
    description: "View a worktree in a floating popup: /wt-switch <id>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /wt-switch <worktree-id>", "warning");
        return;
      }
      await switchToWorktree(id, ctx);
    },
  });

  // ── /wt-remove — Remove worktree ─────────────────────────────

  pi.registerCommand("wt-remove", {
    description: "Remove a worktree agent: /wt-remove <id>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id || !manager) {
        ctx.ui.notify("Usage: /wt-remove <worktree-id>", "warning");
        return;
      }

      killWorktreeSession(id);
      await manager.remove(id);
      await refreshRegistryCache();
      syncWidgetVisibility(ctx);
      widget?.refresh();
      ctx.ui.notify(`Removed worktree: ${id}`, "info");
    },
  });

  // ── /wt-merge — Merge worktree branch back ──────────────────────

  pi.registerCommand("wt-merge", {
    description: "Merge a worktree's changes back: /wt-merge <id>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id || !manager) {
        ctx.ui.notify("Usage: /wt-merge <worktree-id>", "warning");
        return;
      }

      const result = await manager.merge(id);
      if (result.ok) {
        killWorktreeSession(id);
        await manager.archive(id);
      }
      await refreshRegistryCache();
      syncWidgetVisibility(ctx);
      widget?.refresh();
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  });

  // ── /wt-diff — Show worktree diff ───────────────────────────────

  pi.registerCommand("wt-diff", {
    description: "Show diff of a worktree's changes: /wt-diff <id>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id || !manager) {
        ctx.ui.notify("Usage: /wt-diff <worktree-id>", "warning");
        return;
      }

      const record = await manager.get(id);
      if (!record) {
        ctx.ui.notify(`Unknown worktree: ${id}`, "error");
        return;
      }

      const { execFileSync: exec } = await import("node:child_process");
      try {
        const diff = exec("git", ["diff", "HEAD"], {
          cwd: record.worktreePath, encoding: "utf-8", timeout: 10_000,
        });
        const status = exec("git", ["status", "--short"], {
          cwd: record.worktreePath, encoding: "utf-8", timeout: 10_000,
        });

        const content = `## Worktree: ${id}\n\n**Branch:** ${record.targetBranch || record.branch}\n**Path:** ${record.worktreePath}\n\n### Changed files\n\`\`\`\n${status.trim() || "(no changes)"}\n\`\`\`\n\n### Diff\n\`\`\`diff\n${diff.trim() || "(no diff)"}\n\`\`\``;

        pi.sendMessage({ customType: "worktree-diff", content, display: true, details: { worktreeId: id } });
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // ── /wt-send — Send message to a running worktree ────────────

  pi.registerCommand("wt-send", {
    description: [
      "Send a message to a running worktree agent.",
      "",
      "Usage:",
      "  /wt-send <id> <message>",
      "",
      "Example:",
      '  /wt-send fix-auth please also add tests for the edge cases',
    ].join("\n"),
    handler: async (args, ctx) => {
      const spaceIdx = args.trim().indexOf(" ");
      if (spaceIdx === -1) {
        ctx.ui.notify("Usage: /wt-send <worktree-id> <message>", "warning");
        return;
      }

      const id = args.trim().slice(0, spaceIdx);
      const message = args.trim().slice(spaceIdx + 1).trim();

      if (!id || !message) {
        ctx.ui.notify("Usage: /wt-send <worktree-id> <message>", "warning");
        return;
      }

      if (!manager) {
        ctx.ui.notify("Not in a git repository", "error");
        return;
      }

      if (!inTmux()) {
        ctx.ui.notify("tmux required for worktree messaging", "error");
        return;
      }

      const record = await manager.get(id);
      if (!record) {
        ctx.ui.notify(`Unknown worktree: ${id}`, "error");
        return;
      }

      if (!isSessionAlive(id)) {
        ctx.ui.notify(`Worktree "${id}" is not running. Use /wt-switch to respawn.`, "error");
        return;
      }

      sendKeysToSession(id, message);
      ctx.ui.notify(`Message sent to ${id}`, "info");
    },
  });

  // ── /wt-context — Import compacted context from a worktree ─────

  pi.registerCommand("wt-context", {
    description: "Import compacted context from a worktree into the current session",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id || !manager) {
        ctx.ui.notify("Usage: /wt-context <worktree-id>", "warning");
        return;
      }

      const record = await manager.get(id);
      if (!record?.sessionFile) {
        ctx.ui.notify(`No session for worktree: ${id}`, "error");
        return;
      }

      ctx.ui.notify(`Compacting context from ${id}...`, "info");
      try {
        const contextDir = manager.getMetaDir();
        const { summary, summaryFile } = await extractWorktreeContext(record, contextDir);
        await manager.update(id, {
          contextSummaryFile: summaryFile,
          lastContextCompactedAt: new Date().toISOString(),
        } as any);
        await refreshRegistryCache();

        pi.sendMessage({
          customType: "worktree-context",
          content: summary,
          display: true,
          details: { worktreeId: id },
        });
        ctx.ui.notify(`Imported context from ${id}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // ── LLM-callable tool: wt_new ─────────────────────────────────

  pi.registerTool({
    name: "wt_new",
    label: "Create Worktree Agent",
    description: [
      "Create a new git worktree with an isolated Pi session.",
      "The session runs in its own tmux pane \u2014 truly parallel.",
      "",
      "NEVER use raw `git worktree` shell commands. Always use this tool.",
      "After creation, tell the user to switch via /worktrees or /wt-switch.",
    ].join("\n"),
    promptSnippet: "Create an isolated git worktree with its own Pi session. Use instead of raw `git worktree` commands.",
    promptGuidelines: [
      "When the user asks to run something in a worktree, use the `wt_new` tool.",
      "NEVER run raw `git worktree add/remove` shell commands.",
      "Always provide a descriptive `branch` name (feat/, fix/, refactor/, etc.).",
      "After creating, tell the user to run /wt-switch <id> to switch to it.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "The task for the worktree agent." }),
      branch: Type.Optional(Type.String({
        description: "Git branch name (e.g. 'feat/auth-refactor'). If omitted, derived from task.",
      })),
      plan_path: Type.Optional(Type.String({
        description: "Path to a plan file (.md) to copy into the worktree and execute.",
      })),
      model: Type.Optional(Type.String({
        description: "Model for the agent. Defaults to current model.",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await createWorktree(
        { task: params.task, branch: params.branch, planPath: params.plan_path, model: params.model },
        ctx,
      );

      if (result.ok) {
        const lines = [
          `Created worktree: ${result.id}`,
          `Branch: ${params.branch || result.id}`,
          `Internal branch: _wt/${params.branch || result.id}`,
          `Path: ${result.worktreePath}`,
          params.plan_path ? `Plan: ${params.plan_path}` : "",
          "",
          `Agent is running in a hidden tmux session.`,
          `Run \`/wt-switch ${result.id}\` to view in a floating popup.`,
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text" as const, text: lines }], details: {} };
      } else {
        return {
          content: [{ type: "text" as const, text: `Failed to create worktree: ${result.error}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ── LLM-callable tool: wt_send ──────────────────────────

  pi.registerTool({
    name: "wt_send",
    label: "Send Message to Worktree",
    description: [
      "Send a message/instruction to a running worktree agent.",
      "The message is delivered as user input to the worktree's Pi session.",
      "The worktree agent will process it as a new task/instruction.",
      "",
      "Use this to orchestrate worktrees from the main session:",
      "- Send follow-up instructions",
      "- Ask for status updates",
      "- Request the agent to focus on specific subtasks",
      "- Coordinate work across multiple worktrees",
    ].join("\n"),
    promptSnippet: "Send a message to a running worktree agent. Use to orchestrate and coordinate worktree agents from main.",
    promptGuidelines: [
      "Use `wt_send` to send instructions or questions to a running worktree agent.",
      "The worktree must be running (alive in tmux) for the message to be delivered.",
      "Messages are delivered as user input — the agent will process them as new tasks.",
      "Combine with `wt_context` to read results back after the agent finishes.",
    ],
    parameters: Type.Object({
      worktree_id: Type.String({ description: "The worktree ID to send the message to" }),
      message: Type.String({ description: "The message/instruction to send to the worktree agent" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!manager) {
        return { content: [{ type: "text" as const, text: "Not in a git repo" }], isError: true, details: {} };
      }
      if (!inTmux()) {
        return { content: [{ type: "text" as const, text: "tmux required for worktree messaging" }], isError: true, details: {} };
      }

      const record = await manager.get(params.worktree_id);
      if (!record) {
        return { content: [{ type: "text" as const, text: `Unknown worktree: ${params.worktree_id}` }], isError: true, details: {} };
      }

      if (!isSessionAlive(params.worktree_id)) {
        return {
          content: [{ type: "text" as const, text: `Worktree "${params.worktree_id}" is not running. Use wt_new to create a new one or /wt-switch to respawn it.` }],
          isError: true,
          details: {},
        };
      }

      sendKeysToSession(params.worktree_id, params.message);

      return {
        content: [{ type: "text" as const, text: `Message sent to worktree "${params.worktree_id}":\n\n> ${params.message.split("\n").join("\n> ")}\n\nThe agent will process it as a new instruction. Use \`wt_context\` later to read back what it accomplished, or \`/wt-switch ${params.worktree_id}\` to view live.` }],
        details: {},
      };
    },
  });

  // ── LLM-callable tool: wt_context ────────────────────────

  pi.registerTool({
    name: "wt_context",
    label: "Get Worktree Context",
    description: "Retrieve compacted context from a spawned worktree's session. Use when you need to understand what another worktree agent accomplished.",
    promptSnippet: "Retrieve compacted session context from a spawned worktree agent.",
    promptGuidelines: [
      "Use `wt_context` when the user asks about what happened in another worktree.",
      "Only call from the main session, not from inside a child worktree.",
    ],
    parameters: Type.Object({
      worktree_id: Type.String({ description: "The worktree ID to get context from" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!manager) {
        return { content: [{ type: "text" as const, text: "Not in a git repo" }], isError: true, details: {} };
      }
      const record = await manager.get(params.worktree_id);
      if (!record?.sessionFile) {
        return { content: [{ type: "text" as const, text: `Unknown worktree: ${params.worktree_id}` }], isError: true, details: {} };
      }
      try {
        const contextDir = manager.getMetaDir();
        const { summary } = await extractWorktreeContext(record, contextDir);
        return { content: [{ type: "text" as const, text: summary }], details: {} };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true, details: {} };
      }
    },
  });

  // ── LLM-callable tool: wt_wait ────────────────────────────

  pi.registerTool({
    name: "wt_wait",
    label: "Wait for Worktrees",
    description: [
      "Wait for one or all worktree agents to finish their current task.",
      "Polls heartbeats until the specified worktrees are no longer busy.",
      "",
      "Use this after dispatching work to worktrees via wt_new or wt_send.",
      "Once done, use wt_gather or wt_context to collect results.",
    ].join("\n"),
    promptSnippet: "Wait for worktree agents to finish. Use after dispatching work, before gathering results.",
    promptGuidelines: [
      "Use `wt_wait` after sending tasks to worktrees with `wt_new` or `wt_send`.",
      "Pass a specific worktree_id, or omit to wait for ALL running worktrees.",
      "Combine: wt_new/wt_send → wt_wait → wt_gather for full fan-out/gather pattern.",
    ],
    parameters: Type.Object({
      worktree_id: Type.Optional(Type.String({ description: "Specific worktree ID to wait for. Omit to wait for all." })),
      timeout_seconds: Type.Optional(Type.Number({ description: "Max seconds to wait (default: 300)" })),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      if (!manager) {
        return { content: [{ type: "text" as const, text: "Not in a git repo" }], isError: true, details: {} };
      }

      const timeoutMs = (params.timeout_seconds ?? 300) * 1000;
      const startTime = Date.now();
      const pollMs = 3000;
      const targetId = params.worktree_id;

      // Determine which worktrees to wait for
      let targetIds: string[];
      if (targetId) {
        const record = await manager.get(targetId);
        if (!record) {
          return { content: [{ type: "text" as const, text: `Unknown worktree: ${targetId}` }], isError: true, details: {} };
        }
        targetIds = [targetId];
      } else {
        // All active non-main worktrees
        const active = await manager.getActive();
        targetIds = active.map(r => r.id);
        if (targetIds.length === 0) {
          return { content: [{ type: "text" as const, text: "No active worktrees to wait for." }], details: {} };
        }
      }

      // Poll until all targets are not busy (or dead)
      while (Date.now() - startTime < timeoutMs) {
        if (signal?.aborted) {
          return { content: [{ type: "text" as const, text: "Wait cancelled." }], details: {} };
        }

        const stillBusy: string[] = [];
        for (const id of targetIds) {
          const hb = heartbeat.findByWorktreeId(id);
          if (hb && hb.busy) {
            stillBusy.push(id);
          }
        }

        if (stillBusy.length === 0) {
          // All done — build status report
          const statuses = targetIds.map(id => {
            const hb = heartbeat.findByWorktreeId(id);
            const alive = isSessionAlive(id);
            const status = !alive ? "dead" : hb?.busy ? "busy" : "idle";
            const activity = hb?.activity || "";
            return `- **${id}**: ${status}${activity ? ` (${activity})` : ""}`;
          }).join("\n");

          const elapsed = Math.round((Date.now() - startTime) / 1000);
          return {
            content: [{ type: "text" as const, text: `All ${targetIds.length} worktree(s) finished (${elapsed}s).\n\n${statuses}\n\nUse \`wt_gather\` to collect all results, or \`wt_context\` for a specific one.` }],
            details: {},
          };
        }

        // Sleep
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }

      // Timeout
      const stillRunning = targetIds.filter(id => {
        const hb = heartbeat.findByWorktreeId(id);
        return hb?.busy;
      });
      return {
        content: [{ type: "text" as const, text: `Timed out after ${params.timeout_seconds ?? 300}s. Still busy: ${stillRunning.join(", ")}` }],
        isError: true,
        details: {},
      };
    },
  });

  // ── LLM-callable tool: wt_gather ──────────────────────────

  pi.registerTool({
    name: "wt_gather",
    label: "Gather All Worktree Contexts",
    description: [
      "Collect and compile context from all (or specified) worktree sessions.",
      "Returns a combined summary of what each worktree accomplished.",
      "",
      "This is the 'gather' step in a fan-out/gather orchestration pattern:",
      "1. wt_new / wt_send — dispatch work to worktrees",
      "2. wt_wait — wait for all to finish",
      "3. wt_gather — collect and compile all results",
    ].join("\n"),
    promptSnippet: "Collect and compile context from all worktree sessions into a combined report.",
    promptGuidelines: [
      "Use `wt_gather` after `wt_wait` to collect results from all worktrees.",
      "Returns a combined markdown report with each worktree's summary.",
      "Optionally pass specific worktree_ids to gather from a subset.",
    ],
    parameters: Type.Object({
      worktree_ids: Type.Optional(Type.Array(Type.String(), { description: "Specific worktree IDs to gather from. Omit for all." })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!manager) {
        return { content: [{ type: "text" as const, text: "Not in a git repo" }], isError: true, details: {} };
      }

      // Determine which worktrees to gather
      let records: WorktreeRecord[];
      if (params.worktree_ids && params.worktree_ids.length > 0) {
        records = [];
        for (const id of params.worktree_ids) {
          const r = await manager.get(id);
          if (r) records.push(r);
        }
      } else {
        records = await manager.getActive();
      }

      if (records.length === 0) {
        return { content: [{ type: "text" as const, text: "No worktrees to gather from." }], details: {} };
      }

      const contextDir = manager.getMetaDir();
      const sections: string[] = [
        `# Worktree Gather Report`,
        ``,
        `Gathered context from ${records.length} worktree(s).`,
        ``,
      ];

      const errors: string[] = [];

      for (const record of records) {
        try {
          const { summary } = await extractWorktreeContext(record, contextDir);
          sections.push(summary);
          sections.push("");
          sections.push("---");
          sections.push("");
        } catch (err: any) {
          errors.push(`- **${record.id}**: ${err.message}`);
        }
      }

      if (errors.length > 0) {
        sections.push(`### Errors`);
        sections.push(...errors);
        sections.push("");
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
        details: {},
      };
    },
  });

  // ── Switch to worktree via floating popup ─────────────────────

  async function switchToWorktree(
    id: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (!manager) return;

    if (!inTmux()) {
      ctx.ui.notify("tmux required for worktree switching", "error");
      return;
    }

    if (id === "main") {
      ctx.ui.notify("You're already on main. Worktree popups auto-dismiss.", "info");
      return;
    }

    // Check if the session is alive
    if (!isSessionAlive(id)) {
      // Session is dead — try to respawn it
      const record = await manager.get(id);
      if (!record?.sessionFile) {
        ctx.ui.notify(`No session for worktree: ${id}`, "error");
        return;
      }

      ctx.ui.notify(`Respawning ${id}\u2026`, "info");
      const piCmd = `pi -e ${SELF} --session ${record.sessionFile}`;
      const ok = spawnWorktreeSession(id, piCmd, record.worktreePath);
      if (!ok) {
        ctx.ui.notify(`Failed to respawn ${id}`, "error");
        return;
      }
    }

    // Open the floating popup (returns immediately — tmux server manages it)
    openPopup(id);
    ctx.ui.notify(`Opened ${id} in popup. Detach (prefix+d) to return.`, "info");
  }

  // ── Keyboard shortcuts ──────────────────────────────────────────

  pi.registerShortcut("ctrl+shift+w", {
    description: "Open worktrees panel",
    handler: async () => {
      pi.sendUserMessage("/worktrees", { deliverAs: "followUp" });
    },
  });

  pi.registerShortcut("ctrl+shift+]", {
    description: "Next worktree",
    handler: async () => {
      if (!currentCtx) return;
      const boxes = getBoxData();
      const worktrees = boxes.filter((b) => b.id !== "main");
      if (worktrees.length === 0) return;
      // If on main, switch to first worktree
      const currentIdx = worktrees.findIndex((b) => b.isActive);
      const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % worktrees.length;
      pi.sendUserMessage(`/wt-switch ${worktrees[nextIdx].id}`, { deliverAs: "followUp" });
    },
  });

  pi.registerShortcut("ctrl+shift+[", {
    description: "Previous worktree",
    handler: async () => {
      if (!currentCtx) return;
      const boxes = getBoxData();
      const worktrees = boxes.filter((b) => b.id !== "main");
      if (worktrees.length === 0) return;
      const currentIdx = worktrees.findIndex((b) => b.isActive);
      const prevIdx = currentIdx <= 0 ? worktrees.length - 1 : currentIdx - 1;
      pi.sendUserMessage(`/wt-switch ${worktrees[prevIdx].id}`, { deliverAs: "followUp" });
    },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

function describeToolActivity(toolName: string, args: any): string {
  const name = toolName || "tool";
  const path = args?.path?.split("/").pop() || "";
  switch (name) {
    case "read": return `reading ${path || "file"}\u2026`;
    case "write": return `writing ${path || "file"}\u2026`;
    case "edit": return `editing ${path || "file"}\u2026`;
    case "bash": return "running command\u2026";
    case "grep": return `searching "${(args?.pattern || "").slice(0, 15)}"\u2026`;
    case "find": return `finding ${(args?.pattern || "files").slice(0, 15)}\u2026`;
    default: return `${name}\u2026`;
  }
}

function syncWidgetVisibility(ctx: ExtensionContext): void {
  if (!widget || !ctx.hasUI) return;
  const hasChildren = cachedRegistryRecords.length > 0;
  if (hasChildren) {
    widget.register(ctx.ui);
  } else {
    widget.unregister(ctx.ui);
  }
}
