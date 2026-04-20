# Plan: pi-worktree-agent — Git Worktree Agent Sessions

## Summary

A Pi extension that manages git worktrees as isolated parallel agent sessions with a unified UI. Each worktree gets its own Pi subprocess with full session isolation. A toggleable widget above the input shows all worktrees and their agent status. The user switches between worktrees like tabs — input, history, and context are scoped per worktree.

**Key differentiator from pi-side-agents:** We don't spawn tmux windows. Instead, we multiplex within the same Pi TUI — a single terminal, multiple isolated agent sessions, switchable via widget/commands. Think tabs, not windows.

**Key differentiator from pi-subagents:** We use real git worktrees for file isolation (not just in-process sessions). Agents can't stomp each other's files. Each agent has its own cwd.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  Pi TUI (single terminal)                                              │
│                                                                        │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐    │
│  │ ● main           │ │ ⠋ fix-auth        │ │ ✓ add-tests      │    │
│  │ running          │ │ running          │ │ done             │    │
│  │ reading auth.ts… │ │ editing index.ts │ │ 8 tests passing  │    │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘    │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Editor (scoped to active worktree)                              │    │
│  │  > fix the auth middleware...                                    │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                        │
│  Status: [main] worktree: ~/proj   2 agents                            │
└───────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **WorktreeManager** — Creates/removes git worktrees, tracks state in `.pi/worktree-agents/registry.json`
2. **AgentSessionManager** — Spawns/manages Pi subprocesses per worktree (JSON mode, streaming events)
3. **WorktreeWidget** — Above-editor widget showing all worktrees with live status
4. **SessionRouter** — Routes input to the active worktree's agent, displays its output
5. **Commands** — `/wt`, `/wt-new`, `/wt-switch`, `/wt-list`, `/wt-remove`

---

## Task 1: WorktreeManager — Git Worktree Lifecycle

**File:** `extensions/pi-worktree-agent/worktree-manager.ts`

### What it does
- Creates worktrees as sibling directories: `<repo>-wt-<slug>-<NNNN>/`
- Tracks all worktrees in `.pi/worktree-agents/registry.json` (same pattern as pi-side-agents)
- File-lock based concurrency (same `withFileLock` pattern from pi-side-agents)
- Reuses worktree slots (same pool pattern from pi-side-agents `allocateWorktree`)
- Cleans up: removes worktree, prunes branch, deletes lock

### Registry Schema
```typescript
interface WorktreeRegistry {
  version: 1;
  worktrees: Record<string, WorktreeRecord>;
}

interface WorktreeRecord {
  id: string;              // slug, e.g. "fix-auth"
  worktreePath: string;    // absolute path
  branch: string;          // "wt-agent/fix-auth"
  status: "creating" | "ready" | "running" | "waiting" | "done" | "failed";
  task: string;            // original task description
  model?: string;          // model used
  createdAt: string;
  updatedAt: string;
  pid?: number;            // Pi subprocess PID
  // Stats from agent subprocess
  toolUses: number;
  turnCount: number;
  activity: string;        // latest activity description
}
```

### Key functions
```typescript
allocateWorktree(repoRoot: string, slug: string): Promise<WorktreeRecord>
removeWorktree(repoRoot: string, id: string): Promise<void>
listWorktrees(repoRoot: string): Promise<WorktreeRecord[]>
refreshWorktreeStatus(repoRoot: string, id: string): Promise<WorktreeRecord>
```

### Inspiration
- `allocateWorktree` from pi-side-agents: worktree slot pooling, branch cleanup, lock files
- `cleanupWorktree` from pi-subagents: branch creation, commit-on-close, prune

---

## Task 2: AgentSessionManager — Pi Subprocess Per Worktree

**File:** `extensions/pi-worktree-agent/agent-session.ts`

### What it does
- Spawns a Pi subprocess per worktree: `pi --mode json -p --no-session --model <model> --tools <tools> --cwd <worktree-path>`
- Streams JSON events from stdout (same as our `_shared.ts` `runAgent`)
- Tracks live state: status, tool count, turns, current activity, response text
- Accepts input: sends user messages via stdin
- Handles lifecycle: start, send message, interrupt (SIGINT), kill

### Key difference from `_shared.ts` `runAgent`
Our current `runAgent` is fire-and-forget (one task, wait for completion). This needs to be **interactive** — the subprocess stays alive and accepts multiple messages.

### Session protocol
```typescript
interface AgentSession {
  id: string;
  worktreeId: string;
  process: ChildProcess;
  status: "starting" | "idle" | "thinking" | "running" | "done" | "error";
  
  // Live state
  activity: string;
  toolUses: number;
  turnCount: number;
  activeTools: Map<string, string>;
  responseText: string;
  
  // Methods
  sendMessage(text: string): void;
  interrupt(): void;
  kill(): void;
  
  // Events
  onStatus(cb: (status: string) => void): void;
  onActivity(cb: (activity: string) => void): void;
  onOutput(cb: (text: string) => void): void;
  onEnd(cb: (exitCode: number) => void): void;
}
```

### Event parsing
Parse the same JSON events as `_shared.ts`:
- `turn_start` → increment turn count
- `tool_call_start` → track active tool
- `tool_execution_start` → increment tool uses
- `tool_execution_end` → remove from active tools
- `message_update` → track thinking/writing/activity
- `message_end` → capture response text
- `agent_end` → session goes idle (waiting for next input)

### Inspiration
- `_shared.ts` `runAgent` event parsing — reuse the same JSON line parser
- pi-subagents `agent-runner.ts` — subprocess lifecycle management
- pi-side-agents `buildLaunchScript` — process launch with env vars

---

## Task 3: WorktreeWidget — Compact Status Box Above Input

**File:** `extensions/pi-worktree-agent/worktree-widget.ts`

### What it does
- Registers as `aboveEditor` widget via `ctx.ui.setWidget`
- Shows a **compact box** listing all git worktrees detected in the current project folder
- Each entry is a single line: **name**, **status**, **summary of current activity**
- The active worktree (receiving input) is highlighted
- Always visible when worktrees exist (toggleable with `/wt` or `Ctrl+Shift+W`)

### Widget rendering — Horizontal boxes
Each worktree is a **small box** rendered side by side horizontally, like browser tabs.
New worktrees are added to the right of existing ones:
```
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ ● main           │ │ ⠋ fix-auth        │ │ ✓ add-tests      │
│ running          │ │ running          │ │ done             │
│ reading auth.ts… │ │ editing index.ts │ │ 8 tests passing  │
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

Each box has 3 rows:
1. **Row 1** — Status icon + worktree name (bold + highlighted if active)
2. **Row 2** — Status word, color-coded (`running` / `idle` / `done` / `failed`)
3. **Row 3** — Summary of what the agent is currently doing

The **active worktree** (receiving input) has a distinct border style:
- Active: bold/accent border, `●` icon
- Others: dim border

### Box layout rules
- Each box is fixed-width (e.g. 20 chars) to keep alignment clean
- Boxes flow left-to-right, wrapping to a second row if terminal is too narrow
- If there are too many to fit, show visible ones + `+N` overflow indicator at the right
- The active box is always visible (scroll into view if overflowed)

### Status indicators (Row 1 icon)
- `●` accent → active worktree (currently receiving input)
- `⠋` spinner → agent is actively working (braille animation)
- `○` dim → idle, waiting for input
- `✓` green → done
- `✗` red → failed/crashed

### Summary text generation
The summary column shows contextual info based on agent state:
- **thinking** → `"thinking…"`
- **tool running** → `"reading auth.ts…"`, `"running npm test…"`, `"editing index.ts…"`
- **writing response** → `"writing 2.3k…"`
- **idle** → `"waiting for input"`
- **done** → last meaningful output (e.g. `"all tests passing"`, `"implemented auth flow"`)
- **failed** → truncated error message

### Auto-detection of existing worktrees
On `session_start`, scan for git worktrees in the current repo:
```bash
git worktree list --porcelain
```
Any existing worktrees (even ones not created by this extension) show up in the box.
Worktrees created by `/wt-new` also appear immediately.

### Status bar integration
```
[fix-auth] ~/project-wt-fix-auth-0001   2 agents
```

### Key patterns from pi-subagents widget
- Braille spinner animation (`SPINNER` array, 80ms interval)
- `requestRender()` for efficient updates without widget re-registration
- `describeActivity()` for human-readable tool descriptions
- Overflow: if >6 worktrees, collapse to top 5 + `+N more`

---

## Task 4: SessionRouter — Input/Output Multiplexing

**File:** `extensions/pi-worktree-agent/session-router.ts`

### What it does
- Intercepts user input and routes it to the active worktree's agent session
- Captures agent output and displays it in the main Pi conversation
- Manages "active worktree" state — which worktree is currently focused
- Handles session switching without losing context

### Input routing
When the user types a message:
1. If active worktree is "main" → normal Pi behavior (no interception)
2. If active worktree is a child → intercept via `input` hook, send to child session, display response

### Output display
Child agent output is displayed as custom messages in the main conversation:
```typescript
pi.sendMessage({
  customType: "worktree-agent-output",
  content: `[fix-auth] ${agentResponse}`,
  display: true,
});
```

### Session switching
When switching worktrees:
1. Update active worktree state
2. Update status bar (show new cwd, branch)
3. Widget highlights new active worktree
4. Input now routes to new session

### Hooks
```typescript
// Intercept input for child sessions
pi.on("input", async (event, ctx) => {
  if (activeWorktree !== "main") {
    event.preventDefault();
    const session = sessions.get(activeWorktree);
    session.sendMessage(event.text);
  }
});
```

---

## Task 5: Commands, Shortcuts, and Input Indicator

**File:** `extensions/pi-worktree-agent/commands.ts`

### Commands

| Command | Description |
|---|---|
| `/worktrees` | Open interactive picker dialog to switch worktrees |
| `/wt-new [-model <model>] <task>` | Create new worktree + spawn agent |
| `/wt-remove <id>` | Kill agent, remove worktree, cleanup branch |
| `/wt-merge <id>` | Merge worktree's branch back to current branch |
| `/wt-diff <id>` | Show diff of worktree's changes vs main |
| `/wt-back` | Switch back to main worktree |

### `/worktrees` — Interactive Picker Dialog
Opens an interactive selection dialog (like pi-fff's `/fff-features` or Pi's file picker):
```
┌─ Switch Worktree ───────────────────────────────┐
│                                                │
│  ▸ ● main          running   reading auth.ts…  │
│    ⠋ fix-auth      running   editing index.ts  │
│    ✓ add-tests     done      8 tests passing   │
│    ○ refactor-db   idle      waiting for input  │
│                                                │
│  ↑↓ navigate  ⏎ select  esc cancel              │
└────────────────────────────────────────────────┘
```
- Arrow keys to navigate, Enter to select, Esc to cancel
- The current active worktree is marked with `▸` cursor + `●`
- Shows same 3-column info: name, status, summary
- Selecting a worktree switches to it immediately

### Input Indicator — Current Worktree Badge
When you're inside a worktree (not main), the editor input shows a badge/prefix:
```
[fix-auth] > type your message here...
```

Implementation: use `ctx.ui.setEditorPrefix()` or prepend to the editor placeholder.
If the API doesn't support a prefix, use the status bar:
```
Status: 🌿 fix-auth · ~/project-wt-fix-auth-0001 · running
```

When on main, no badge — clean default input.

### Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+W` | Open `/worktrees` picker dialog |
| `Ctrl+Shift+N` | New worktree (prompts for task) |
| `Ctrl+Shift+]` | Quick-switch to next worktree |
| `Ctrl+Shift+[` | Quick-switch to previous worktree |

### `/wt-new` flow
1. Parse args (model, task)
2. Generate slug from task (same `generateSlug` pattern as pi-side-agents)
3. `worktreeManager.allocateWorktree(repoRoot, slug)`
4. `agentSessionManager.startSession(worktree, task, model)`
5. Update widget boxes
6. Auto-switch to new worktree (input now scoped to it)
7. New box appears to the right of existing boxes in the widget

### `/wt-merge` flow
1. Verify worktree agent is done or idle
2. `git -C <worktree> add -A && git -C <worktree> commit -m "wt-agent: <task>"`
3. `git merge <branch>` in main repo
4. `worktreeManager.removeWorktree(id)`
5. Switch back to main, remove box from widget

### `/wt-back` flow
1. Switch active worktree to main
2. Clear input badge
3. Highlight main box in widget

---

## Task 6: Extension Entry Point and Integration

**File:** `extensions/pi-worktree-agent/index.ts`

### What it does
- Registers as a Pi extension with `pi.on("session_start", ...)`
- Initializes WorktreeManager, AgentSessionManager, WorktreeWidget
- Registers all commands and shortcuts
- Sets up polling for agent status updates (2.5s interval, like pi-side-agents)
- Handles cleanup on `session_shutdown`

### Integration with existing extensions
- **condensed-milk**: Child agents benefit from output compression (no `--no-extensions`)
- **pi-fff**: Child agents get indexed search
- **pi-vim**: Widget doesn't interfere with editor (uses `aboveEditor` placement)
- **pi-notify**: Main session gets notified when child agents finish

### Status bar
```typescript
// Show active worktree in sub-bar
ctx.ui.setStatus("worktree-agent", `[${activeId}] ${worktreePath} · ${agentCount} agent(s)`);
```

---

## Edge Cases and Risks

1. **Multiple Pi instances**: File locks on registry.json prevent corruption (pi-side-agents pattern)
2. **Orphan processes**: On crash, stale PIDs are detected on next startup and cleaned up
3. **Worktree limit**: Pool max ~10 worktrees, reuse slots (pi-side-agents pattern)
4. **Large repos**: Worktrees are lightweight (shared .git objects), but `node_modules` etc need symlink or fresh install — use `side-agent-start.sh` pattern
5. **Branch conflicts**: Worktree branches namespaced as `wt-agent/<slug>`, auto-deduplicated
6. **Session persistence**: Worktree sessions are ephemeral (no `--session`). If Pi restarts, active sessions are lost but worktrees/branches survive for manual recovery.

---

## Acceptance Criteria

- [ ] `/wt-new "fix auth bug"` creates a worktree, spawns an agent, new box appears to the right
- [ ] Horizontal boxes above input show all worktrees with name, status, and summary
- [ ] `/worktrees` opens an interactive picker dialog to switch between worktrees
- [ ] Input shows `[fix-auth] >` badge when inside a worktree session
- [ ] Input typed while on a child worktree goes to that agent, not main
- [ ] `/wt-back` returns to main, clears the input badge
- [ ] `/wt-merge fix-auth` merges changes back, removes the box
- [ ] `Ctrl+Shift+W` opens the worktree picker
- [ ] `Ctrl+Shift+]` / `Ctrl+Shift+[` cycles through worktrees
- [ ] Boxes show live spinner animation for running agents
- [ ] Active box has distinct highlight/border vs inactive boxes
- [ ] Child agents inherit extensions (condensed-milk, pi-fff)
- [ ] Orphan cleanup works on restart
- [ ] No conflicts with pi-vim, pi-subagents, or other installed extensions

---

## File Structure

```
extensions/pi-worktree-agent/
├── index.ts                 # Entry point, hooks, lifecycle
├── worktree-manager.ts      # Git worktree CRUD + registry
├── agent-session.ts         # Pi subprocess per worktree (interactive)
├── worktree-widget.ts       # Above-editor status widget
├── session-router.ts        # Input/output multiplexing
├── commands.ts              # Slash commands + shortcuts
└── types.ts                 # Shared types
```

**Estimated total:** ~1500-2000 lines of TypeScript
