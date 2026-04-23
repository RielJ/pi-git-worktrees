/**
 * WorktreesPanel — `/worktrees` overlay dialog with tabs + shortcuts.
 *
 * Mutating actions (remove, merge, cleanup) execute inline with a
 * spinner — the dialog stays open and refreshes after completion.
 * Only switch / new-worktree close the dialog.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import type { TUI } from "@mariozechner/pi-tui";
import type { WorktreeBoxData, WorktreeStatus } from "./types.js";

// ── Constants ───────────────────────────────────────────────────────

const MAX_VISIBLE_ROWS = 10;
const OVERLAY_WIDTH = 72;
const TAB_NAMES = ["Worktrees", "Actions", "Settings"] as const;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ── Result type (only things that CLOSE the dialog) ─────────────────

export type PanelResult =
  | { type: "cancel" }
  | { type: "switch"; worktreeId: string };

// ── Action handlers — executed inline without closing ───────────────

export interface PanelActionHandlers {
  /** Create a new worktree. Returns success/error message. */
  create(task: string): Promise<string>;
  /** Remove a worktree. Returns success/error message. */
  remove(id: string): Promise<string>;
  /** Merge a worktree. Returns success/error message. */
  merge(id: string): Promise<string>;
  /** Import context from a worktree. Returns success/error message. */
  context(id: string): Promise<string>;
  /** Show diff for a worktree. Returns diff summary. */
  diff(id: string): Promise<string>;
  /** Send a message to a running worktree. Returns success/error message. */
  send(id: string, message: string): Promise<string>;
  /** Run cleanup / reconcile. Returns message. */
  cleanup(): Promise<string>;
  /** Toggle widget visibility. Returns message. */
  toggleWidget(): Promise<string>;
}

// ── ANSI helpers ────────────────────────────────────────────────────

function sgr(code: string, text: string): string {
  if (!code) return text;
  return `\u001B[${code}m${text}\u001B[0m`;
}
function bold(text: string): string {
  return `\u001B[1m${text}\u001B[22m`;
}
function italic(text: string): string {
  return `\u001B[3m${text}\u001B[23m`;
}
function dim(text: string): string {
  return `\u001B[2m${text}\u001B[22m`;
}

// ── Row helpers ─────────────────────────────────────────────────────

function makeRow(innerW: number): (content: string) => string {
  return (content: string): string =>
    `${dim("│")}${truncateToWidth(` ${content}`, innerW, "…", true)}${dim("│")}`;
}
function makeEmptyRow(innerW: number): () => string {
  return (): string => `${dim("│")}${" ".repeat(innerW)}${dim("│")}`;
}
function makeDivider(innerW: number): () => string {
  return (): string => dim(`├${"─".repeat(innerW)}┤`);
}
function makeCenterRow(innerW: number): (content: string) => string {
  return (content: string): string => {
    const vis = visibleWidth(content);
    const padding = Math.max(0, innerW - vis);
    const left = Math.floor(padding / 2);
    return `${dim("│")}${" ".repeat(left)}${content}${" ".repeat(padding - left)}${dim("│")}`;
  };
}
function renderTitleBorder(innerW: number): string {
  const titleText = " Worktrees ";
  const borderLen = innerW - visibleWidth(titleText);
  const leftBorder = Math.floor(borderLen / 2);
  const rightBorder = borderLen - leftBorder;
  return dim(
    `╭${"─".repeat(leftBorder)}${titleText}${"─".repeat(rightBorder)}╮`,
  );
}

// ── Status helpers ──────────────────────────────────────────────────

function statusIcon(status: WorktreeStatus, isActive: boolean): string {
  if (isActive) return sgr("36", "●");
  switch (status) {
    case "running":  return sgr("33", "◉");
    case "idle":
    case "ready":    return dim("○");
    case "done":     return sgr("32", "✓");
    case "failed":   return sgr("31", "✗");
    case "creating": return dim("…");
    default:         return dim("?");
  }
}

function statusColor(status: WorktreeStatus): string {
  switch (status) {
    case "running": return "33";
    case "done":    return "32";
    case "failed":  return "31";
    default:        return "2";
  }
}

// ── Action definitions ──────────────────────────────────────────────

interface ActionItem {
  id: string;
  label: string;
  shortcut: string;
  description: string;
}

function getActionsForWorktree(box: WorktreeBoxData): ActionItem[] {
  const actions: ActionItem[] = [];
  if (!box.isActive) {
    actions.push({ id: "switch", label: "Switch", shortcut: "⏎", description: "Switch to this worktree session" });
  }
  if (box.id !== "main") {
    if (box.status === "running" || box.status === "idle" || box.status === "ready") {
      actions.push({ id: "send", label: "Send Message", shortcut: "s", description: "Send instruction to this worktree" });
    }
    actions.push({ id: "diff",    label: "Diff",           shortcut: "/", description: "Show diff for this worktree" });
    actions.push({ id: "context", label: "Import Context", shortcut: "c", description: "Compact & import context to main" });
    if (box.status === "done" || box.status === "idle" || box.status === "failed") {
      actions.push({ id: "merge", label: "Merge",  shortcut: "m", description: "Merge branch into main and archive" });
    }
    actions.push({ id: "remove", label: "Remove", shortcut: "d", description: "Delete worktree, branch, and session" });
  }
  return actions;
}

// ── Settings items ──────────────────────────────────────────────────

interface SettingItem {
  id: string;
  label: string;
  description: string;
}

const SETTING_ITEMS: SettingItem[] = [
  { id: "cleanup",  label: "🧹 Run Cleanup",   description: "Reconcile registry & prune orphans" },
  { id: "toggle",   label: "👁 Toggle Widget",  description: "Show/hide the worktree boxes above input" },
];

// ── Overlay component ───────────────────────────────────────────────

class WorktreesOverlay {
  private boxes: WorktreeBoxData[];
  private getBoxData: () => WorktreeBoxData[];
  private handlers: PanelActionHandlers;
  private tui: TUI;
  private done: (result: PanelResult | null) => void;

  // Navigation state
  private activeTab = 0;
  private worktreeIndex = 0;
  private actionIndex = 0;
  private settingIndex = 0;
  private scrollOffset = 0;

  // Input mode (for new worktree or send message)
  private inputMode: false | "create" | "send" = false;
  private inputText = "";
  private sendTargetId = "";

  // Busy state (inline action running)
  private busy = false;
  private busyMessage = "";
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  // Inline status message (shown after action completes)
  private statusMessage = "";
  private statusIsError = false;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  // Cache
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    tui: TUI,
    getBoxData: () => WorktreeBoxData[],
    handlers: PanelActionHandlers,
    done: (result: PanelResult | null) => void,
  ) {
    this.tui = tui;
    this.getBoxData = getBoxData;
    this.handlers = handlers;
    this.boxes = getBoxData();
    this.done = done;
  }

  cleanup(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
  }

  // ── Refresh box data after mutations ────────────────────────────

  private refreshBoxes(): void {
    this.boxes = this.getBoxData();
    // Clamp worktreeIndex if list shrank
    if (this.worktreeIndex >= this.boxes.length) {
      this.worktreeIndex = Math.max(0, this.boxes.length - 1);
    }
    this.actionIndex = 0;
    this.invalidate();
  }

  // ── Status message ──────────────────────────────────────────────

  private showStatus(message: string, isError = false): void {
    this.statusMessage = message;
    this.statusIsError = isError;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.statusMessage = "";
      this.invalidate();
      this.tui.requestRender();
    }, 4000);
    this.invalidate();
  }

  // ── Spinner ─────────────────────────────────────────────────────

  private startSpinner(message: string): void {
    this.busy = true;
    this.busyMessage = message;
    this.spinnerFrame = 0;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame++;
      this.invalidate();
      this.tui.requestRender();
    }, 100);
    this.invalidate();
  }

  private stopSpinner(): void {
    this.busy = false;
    this.busyMessage = "";
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.invalidate();
  }

  // ── Execute an inline action ────────────────────────────────────

  private async executeInline(
    label: string,
    action: () => Promise<string>,
  ): Promise<void> {
    this.startSpinner(label);
    this.tui.requestRender();

    try {
      const msg = await action();
      this.stopSpinner();
      this.refreshBoxes();
      this.showStatus(msg);
    } catch (err: any) {
      this.stopSpinner();
      this.refreshBoxes();
      this.showStatus(err.message || "Failed", true);
    }

    this.tui.requestRender();
  }

  // ── Derived data ────────────────────────────────────────────────

  private get selectedBox(): WorktreeBoxData | undefined {
    return this.boxes[this.worktreeIndex];
  }

  private get actionItems(): ActionItem[] {
    const box = this.selectedBox;
    if (!box) return [];
    return getActionsForWorktree(box);
  }

  private get selectedIndex(): number {
    switch (this.activeTab) {
      case 0: return this.worktreeIndex;
      case 1: return this.actionIndex;
      case 2: return this.settingIndex;
      default: return 0;
    }
  }
  private set selectedIndex(v: number) {
    switch (this.activeTab) {
      case 0: this.worktreeIndex = v; break;
      case 1: this.actionIndex = v; break;
      case 2: this.settingIndex = v; break;
    }
  }

  private getItemCount(): number {
    switch (this.activeTab) {
      case 0: return this.boxes.length;
      case 1: return this.actionItems.length;
      case 2: return SETTING_ITEMS.length;
      default: return 0;
    }
  }

  // ── Input ───────────────────────────────────────────────────────

  handleInput(data: string): void {
    // Block all input while busy
    if (this.busy) return;

    // Input mode
    if (this.inputMode) {
      this.handleInputMode(data);
      return;
    }

    // Escape / q → close
    if (matchesKey(data, "escape") || data === "q") {
      this.cleanup();
      this.done({ type: "cancel" });
      return;
    }

    // ←→ or h/l → switch tabs
    if (matchesKey(data, "left") || data === "h") { this.switchTab(-1); return; }
    if (matchesKey(data, "right") || data === "l") { this.switchTab(1); return; }

    // Tab numbers 1/2/3
    if (data === "1") { this.setTab(0); return; }
    if (data === "2") { this.setTab(1); return; }
    if (data === "3") { this.setTab(2); return; }

    // ↑↓ or j/k → navigate
    if (matchesKey(data, "up") || data === "k") { this.moveSelection(-1); return; }
    if (matchesKey(data, "down") || data === "j") { this.moveSelection(1); return; }

    // Enter → primary action
    if (matchesKey(data, "enter")) { this.handleEnter(); return; }

    // ── Keyboard shortcuts ──
    const box = this.selectedBox;
    if (!box) return;

    // n → new worktree
    if (data === "n") {
      this.inputMode = "create";
      this.inputText = "";
      this.invalidate();
      return;
    }

    if (box.id === "main") return;

    // s → send message (inline input)
    if (data === "s" && (box.status === "running" || box.status === "idle" || box.status === "ready")) {
      this.inputMode = "send";
      this.sendTargetId = box.id;
      this.inputText = "";
      this.invalidate();
      return;
    }

    // d → remove (inline)
    if (data === "d") {
      this.executeInline(`Removing ${box.id}…`, () => this.handlers.remove(box.id));
      return;
    }

    // m → merge (inline)
    if (data === "m" && (box.status === "done" || box.status === "idle" || box.status === "failed")) {
      this.executeInline(`Merging ${box.id}…`, () => this.handlers.merge(box.id));
      return;
    }

    // c → context (inline)
    if (data === "c") {
      this.executeInline(`Importing context from ${box.id}…`, () => this.handlers.context(box.id));
      return;
    }

    // / → diff (inline)
    if (data === "/") {
      this.executeInline(`Diffing ${box.id}…`, () => this.handlers.diff(box.id));
      return;
    }
  }

  private switchTab(delta: number): void {
    const next = this.activeTab + delta;
    if (next < 0 || next >= TAB_NAMES.length) return;
    this.setTab(next);
  }

  private setTab(tab: number): void {
    this.activeTab = tab;
    if (tab === 1) this.actionIndex = 0;
    if (tab === 2) this.settingIndex = 0;
    this.scrollOffset = 0;
    this.invalidate();
  }

  private moveSelection(delta: number): void {
    const count = this.getItemCount();
    if (count === 0) return;
    let next = this.selectedIndex + delta;
    if (next < 0) next = count - 1;
    if (next >= count) next = 0;
    this.selectedIndex = next;
    if (next < this.scrollOffset) this.scrollOffset = next;
    else if (next >= this.scrollOffset + MAX_VISIBLE_ROWS) this.scrollOffset = next - MAX_VISIBLE_ROWS + 1;
    this.invalidate();
  }

  private handleEnter(): void {
    switch (this.activeTab) {
      case 0: {
        const box = this.selectedBox;
        if (box) {
          this.cleanup();
          this.done({ type: "switch", worktreeId: box.id });
        }
        break;
      }
      case 1: {
        const box = this.selectedBox;
        const actions = this.actionItems;
        if (box && actions[this.actionIndex]) {
          const action = actions[this.actionIndex];
          if (action.id === "switch") {
            this.cleanup();
            this.done({ type: "switch", worktreeId: box.id });
          } else {
            // Execute inline
            this.dispatchAction(action.id, box.id);
          }
        }
        break;
      }
      case 2: {
        const setting = SETTING_ITEMS[this.settingIndex];
        if (setting) {
          this.dispatchSetting(setting.id);
        }
        break;
      }
    }
  }

  private dispatchAction(actionId: string, worktreeId: string): void {
    switch (actionId) {
      case "remove":
        this.executeInline(`Removing ${worktreeId}…`, () => this.handlers.remove(worktreeId));
        break;
      case "merge":
        this.executeInline(`Merging ${worktreeId}…`, () => this.handlers.merge(worktreeId));
        break;
      case "context":
        this.executeInline(`Importing context…`, () => this.handlers.context(worktreeId));
        break;
      case "diff":
        this.executeInline(`Diffing ${worktreeId}…`, () => this.handlers.diff(worktreeId));
        break;
      case "send":
        this.inputMode = "send";
        this.sendTargetId = worktreeId;
        this.inputText = "";
        this.invalidate();
        break;
    }
  }

  private dispatchSetting(settingId: string): void {
    switch (settingId) {
      case "cleanup":
        this.executeInline("Running cleanup…", () => this.handlers.cleanup());
        break;
      case "toggle":
        this.executeInline("Toggling widget…", () => this.handlers.toggleWidget());
        break;
    }
  }

  // ── Input mode ──────────────────────────────────────────────────

  private handleInputMode(data: string): void {
    if (matchesKey(data, "escape")) {
      this.inputMode = false;
      this.inputText = "";
      this.sendTargetId = "";
      this.invalidate();
      return;
    }
    if (matchesKey(data, "enter")) {
      const text = this.inputText.trim();
      if (text) {
        const mode = this.inputMode;
        const targetId = this.sendTargetId;
        this.inputMode = false;
        this.inputText = "";
        this.sendTargetId = "";
        if (mode === "send" && targetId) {
          this.executeInline(`Sending to ${targetId}…`, () => this.handlers.send(targetId, text));
        } else {
          this.executeInline(`Creating worktree…`, () => this.handlers.create(text));
        }
      }
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (this.inputText.length > 0) {
        this.inputText = this.inputText.slice(0, -1);
        this.invalidate();
      }
      return;
    }
    if (data === "\x15") { this.inputText = ""; this.invalidate(); return; }
    if (data === "\x17") { this.inputText = this.inputText.replace(/\S+\s*$/, ""); this.invalidate(); return; }
    if (data.length === 1 && (data.codePointAt(0) ?? 0) >= 32) {
      this.inputText += data;
      this.invalidate();
      return;
    }
    if (data.length > 1 && [...data].every(ch => (ch.codePointAt(0) ?? 0) >= 32)) {
      this.inputText += data;
      this.invalidate();
    }
  }

  // ── Rendering ───────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const w = Math.min(width, OVERLAY_WIDTH);
    const innerW = w - 2;
    const row = makeRow(innerW);
    const emptyRow = makeEmptyRow(innerW);
    const divider = makeDivider(innerW);
    const centerRow = makeCenterRow(innerW);

    const lines: string[] = [];

    // ── Title border ──
    lines.push(renderTitleBorder(innerW));
    lines.push(emptyRow());

    // ── Tab bar ──
    const tabs = TAB_NAMES.map((name, i) => {
      if (i === this.activeTab) return sgr("36", bold(`[· ${name} ·]`));
      return dim(`[ ${name} ]`);
    });
    lines.push(row(tabs.join("  ")));
    lines.push(emptyRow());
    lines.push(divider());
    lines.push(emptyRow());

    // ── Busy spinner ──
    if (this.busy) {
      const spin = sgr("33", SPINNER[this.spinnerFrame % SPINNER.length]);
      lines.push(centerRow(`${spin} ${sgr("33", this.busyMessage)}`));
      lines.push(emptyRow());
    }
    // ── Input mode ──
    else if (this.inputMode) {
      this.renderInputMode(lines, innerW, row, emptyRow, centerRow);
    }
    // ── Tab content ──
    else {
      switch (this.activeTab) {
        case 0: this.renderWorktreesTab(lines, innerW, row, emptyRow, centerRow); break;
        case 1: this.renderActionsTab(lines, innerW, row, emptyRow, centerRow); break;
        case 2: this.renderSettingsTab(lines, innerW, row, emptyRow, centerRow); break;
      }
    }

    // ── Status message (inline feedback) ──
    if (this.statusMessage) {
      lines.push(divider());
      const color = this.statusIsError ? "31" : "32";
      const icon = this.statusIsError ? "✗" : "✓";
      lines.push(row(`${sgr(color, icon)} ${sgr(color, this.statusMessage)}`));
    }

    // ── Footer ──
    lines.push(divider());
    lines.push(emptyRow());

    const hints = this.busy
      ? dim("working…")
      : this.inputMode === "send"
        ? `${italic("⏎")} send  ${italic("Esc")} cancel`
        : this.inputMode === "create"
          ? `${italic("⏎")} create  ${italic("Esc")} cancel`
          : this.getHints();
    lines.push(centerRow(dim(hints)));

    lines.push(dim(`╰${"─".repeat(innerW)}╯`));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private renderWorktreesTab(
    lines: string[], innerW: number,
    row: ReturnType<typeof makeRow>,
    emptyRow: ReturnType<typeof makeEmptyRow>,
    centerRow: ReturnType<typeof makeCenterRow>,
  ): void {
    if (this.boxes.length === 0) {
      lines.push(centerRow(dim(italic("No worktrees"))));
      lines.push(emptyRow());
      return;
    }
    const startIdx = this.scrollOffset;
    const endIdx = Math.min(startIdx + MAX_VISIBLE_ROWS, this.boxes.length);
    for (let i = startIdx; i < endIdx; i++) {
      const box = this.boxes[i];
      const isSelected = i === this.worktreeIndex;
      const prefix = isSelected ? sgr("36", "▸") : " ";
      const icon = statusIcon(box.status, box.isActive);
      const name = isSelected
        ? sgr("36", bold(box.name))
        : box.isActive ? sgr("36", box.name) : bold(box.name);
      const status = sgr(statusColor(box.status), box.status);
      const summary = dim(truncateToWidth(box.summary, 22, "…"));
      lines.push(row(`${prefix} ${icon} ${name}  ${status}  ${summary}`));
    }
    lines.push(emptyRow());
    if (this.boxes.length > MAX_VISIBLE_ROWS) {
      lines.push(centerRow(dim(`${this.worktreeIndex + 1}/${this.boxes.length}`)));
      lines.push(emptyRow());
    }
  }

  private renderActionsTab(
    lines: string[], innerW: number,
    row: ReturnType<typeof makeRow>,
    emptyRow: ReturnType<typeof makeEmptyRow>,
    centerRow: ReturnType<typeof makeCenterRow>,
  ): void {
    const box = this.selectedBox;
    if (!box) { lines.push(centerRow(dim(italic("No worktree selected")))); lines.push(emptyRow()); return; }
    const icon = statusIcon(box.status, box.isActive);
    lines.push(row(`${dim("for")} ${icon} ${sgr("36", bold(box.name))}  ${dim(box.branch || "")}`));
    lines.push(emptyRow());
    const actions = getActionsForWorktree(box);
    if (actions.length === 0) { lines.push(centerRow(dim(italic("No actions available")))); lines.push(emptyRow()); return; }
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      const sel = i === this.actionIndex;
      const prefix = sel ? sgr("36", "▸") : " ";
      const label = sel ? sgr("36", bold(a.label)) : a.label;
      lines.push(row(`${prefix} ${dim(`[${a.shortcut}]`)} ${label}  ${dim(a.description)}`));
    }
    lines.push(emptyRow());
  }

  private renderSettingsTab(
    lines: string[], innerW: number,
    row: ReturnType<typeof makeRow>,
    emptyRow: ReturnType<typeof makeEmptyRow>,
    _centerRow: ReturnType<typeof makeCenterRow>,
  ): void {
    for (let i = 0; i < SETTING_ITEMS.length; i++) {
      const s = SETTING_ITEMS[i];
      const sel = i === this.settingIndex;
      const prefix = sel ? sgr("36", "▸") : " ";
      const label = sel ? sgr("36", bold(s.label)) : s.label;
      lines.push(row(`${prefix} ${label}  ${dim(s.description)}`));
    }
    lines.push(emptyRow());
  }

  private renderInputMode(
    lines: string[], innerW: number,
    row: ReturnType<typeof makeRow>,
    emptyRow: ReturnType<typeof makeEmptyRow>,
    _centerRow: ReturnType<typeof makeCenterRow>,
  ): void {
    lines.push(emptyRow());

    if (this.inputMode === "send") {
      lines.push(row(sgr("36", bold(`Send to ${this.sendTargetId}`))));
      lines.push(emptyRow());
      lines.push(row(dim("Type the message/instruction to send:")));
    } else {
      lines.push(row(sgr("36", bold("New Worktree"))));
      lines.push(emptyRow());
      lines.push(row(dim("Describe the task for the new worktree agent:")));
    }

    lines.push(emptyRow());
    const cursor = sgr("36", "│");
    const maxInputW = innerW - 8;
    const displayText = this.inputText.length > maxInputW
      ? "…" + this.inputText.slice(-(maxInputW - 1))
      : this.inputText;
    const placeholder = this.inputMode === "send"
      ? "e.g. also add tests for edge cases"
      : "e.g. fix the auth middleware";
    const inputLine = this.inputText
      ? `${displayText}${cursor}`
      : `${cursor}${dim(italic(placeholder))}`;
    lines.push(row(`  ${sgr("36", "❯")} ${inputLine}`));
    lines.push(emptyRow());
    lines.push(emptyRow());
  }

  private getHints(): string {
    const parts: string[] = [];
    parts.push(`${italic("←→")} tabs`);
    parts.push(`${italic("↑↓")} navigate`);
    if (this.activeTab === 0) {
      parts.push(`${italic("⏎")} switch`);
      parts.push(`${italic("n")} new`);
      const box = this.selectedBox;
      if (box && box.id !== "main") {
        if (box.status === "running" || box.status === "idle" || box.status === "ready")
          parts.push(`${italic("s")} send`);
        parts.push(`${italic("d")} remove`);
        if (box.status === "done" || box.status === "idle" || box.status === "failed")
          parts.push(`${italic("m")} merge`);
        parts.push(`${italic("c")} context`);
        parts.push(`${italic("/")} diff`);
      }
    } else {
      parts.push(`${italic("⏎")} select`);
    }
    parts.push(`${italic("Esc")} close`);
    return parts.join("  ");
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── Show the panel ──────────────────────────────────────────────────

export function showWorktreesPanel(
  ctx: ExtensionCommandContext,
  getBoxData: () => WorktreeBoxData[],
  handlers: PanelActionHandlers,
): Promise<PanelResult> {
  return new Promise((resolve) => {
    ctx.ui.custom<PanelResult | null>(
      (tui, _theme, _kb, done) => {
        const overlay = new WorktreesOverlay(tui, getBoxData, handlers, done);
        return {
          render: (width: number) => overlay.render(width),
          invalidate: () => overlay.invalidate(),
          handleInput: (data: string) => {
            overlay.handleInput(data);
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: OVERLAY_WIDTH },
      },
    ).then((result) => {
      resolve(result ?? { type: "cancel" });
    });
  });
}
