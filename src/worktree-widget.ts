/**
 * WorktreeWidget — Horizontal boxes above the input showing all worktrees
 *
 * Each worktree is a small box rendered side by side.
 * Shows: name, status, summary of current activity.
 * Active worktree has highlighted border.
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import type { WorktreeBoxData } from "./types.js";

// ── Constants ───────────────────────────────────────────────────────

/** Braille spinner frames */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Fixed inner width of each box (content area, excluding borders) */
const BOX_INNER_WIDTH = 20;

/** Box outer width (inner + 2 for left/right border chars + 2 spaces) */
const BOX_OUTER_WIDTH = BOX_INNER_WIDTH + 4;

/** Gap between boxes */
const BOX_GAP = 1;

// ── Box Rendering ───────────────────────────────────────────────────

function statusIcon(
  data: WorktreeBoxData,
  frame: number,
  theme: any,
): string {
  if (data.isActive) return theme.fg("accent", "●");
  switch (data.status) {
    case "running":
      return theme.fg("warning", SPINNER[frame % SPINNER.length]);
    case "idle":
    case "ready":
      return theme.fg("dim", "○");
    case "done":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "creating":
      return theme.fg("dim", "…");
    default:
      return theme.fg("dim", "?");
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "running": return "warning";
    case "idle":
    case "ready": return "dim";
    case "done": return "success";
    case "failed": return "error";
    case "creating": return "dim";
    default: return "dim";
  }
}

function pad(text: string, width: number): string {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  const len = stripped.length;
  if (len >= width) return text;
  return text + " ".repeat(width - len);
}

function truncPlain(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/**
 * Render a single worktree box as an array of 5 lines (top border, row1, row2, row3, bottom border).
 */
function renderBox(
  data: WorktreeBoxData,
  frame: number,
  theme: any,
): string[] {
  const w = BOX_INNER_WIDTH;
  const borderColor = data.isActive ? "accent" : "border";
  const nameColor = data.isActive ? "accent" : "text";

  const topBorder = theme.fg(borderColor, "┌" + "─".repeat(w + 2) + "┐");
  const botBorder = theme.fg(borderColor, "└" + "─".repeat(w + 2) + "┘");
  const leftB = theme.fg(borderColor, "│ ");
  const rightB = theme.fg(borderColor, " │");

  // Row 1: icon + name
  const icon = statusIcon(data, frame, theme);
  const name = data.isActive
    ? theme.fg(nameColor, theme.bold(truncPlain(data.name, w - 2)))
    : theme.fg(nameColor, truncPlain(data.name, w - 2));
  const row1Content = `${icon} ${name}`;
  const row1 = leftB + pad(row1Content, w) + rightB;

  // Row 2: branch
  const branchText = theme.fg("dim", truncPlain(data.branch || "—", w));
  const row2 = leftB + pad(branchText, w) + rightB;

  // Row 3: status word
  const stColor = statusColor(data.status);
  const stWord = theme.fg(stColor, truncPlain(data.status, w));
  const row3 = leftB + pad(stWord, w) + rightB;

  // Row 4: summary
  const summary = theme.fg("dim", truncPlain(data.summary || "—", w));
  const row4 = leftB + pad(summary, w) + rightB;

  return [topBorder, row1, row2, row3, row4, botBorder];
}

// ── Widget Class ────────────────────────────────────────────────────

export type GetBoxDataFn = () => WorktreeBoxData[];

export class WorktreeWidget {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tui: any | undefined;
  private registered = false;
  private visible = true;

  constructor(
    private getBoxData: GetBoxDataFn,
  ) {}

  /**
   * Register the widget with the Pi UI context.
   */
  register(uiCtx: any): void {
    if (this.registered) return;

    uiCtx.setWidget(
      "git-worktrees",
      (tui: any, theme: any) => {
        this.tui = tui;
        return {
          render: (width: number) => this.render(width, theme),
          invalidate: () => {
            this.registered = false;
            this.tui = undefined;
          },
          dispose: () => {
            this.stopTimer();
          },
        };
      },
      { placement: "aboveEditor" },
    );

    this.registered = true;
    this.startTimer();
  }

  /**
   * Unregister the widget.
   */
  unregister(uiCtx: any): void {
    uiCtx.setWidget("git-worktrees", undefined);
    this.registered = false;
    this.tui = undefined;
    this.stopTimer();
  }

  /**
   * Toggle visibility.
   */
  toggle(uiCtx: any): void {
    this.visible = !this.visible;
    if (this.visible) {
      this.register(uiCtx);
    } else {
      this.unregister(uiCtx);
    }
  }

  /**
   * Force a re-render.
   */
  refresh(): void {
    this.frame++;
    this.tui?.requestRender();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame++;
      this.tui?.requestRender();
    }, 200);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as any).unref();
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Render all worktree boxes side by side.
   * Returns an array of lines to display.
   */
  private render(termWidth: number, theme: any): string[] {
    const boxes = this.getBoxData();
    if (boxes.length === 0) return [];

    // How many boxes fit in the terminal width?
    const maxBoxes = Math.max(1, Math.floor((termWidth + BOX_GAP) / (BOX_OUTER_WIDTH + BOX_GAP)));
    const visibleBoxes = boxes.slice(0, maxBoxes);
    const overflow = boxes.length - visibleBoxes.length;

    // Render each visible box (each is 6 lines)
    const renderedBoxes = visibleBoxes.map((b) => renderBox(b, this.frame, theme));

    // Merge horizontally: zip lines side by side
    const lines: string[] = [];
    const numRows = 6; // top border, row1 (name), row2 (branch), row3 (status), row4 (summary), bottom border

    for (let row = 0; row < numRows; row++) {
      let line = "";
      for (let i = 0; i < renderedBoxes.length; i++) {
        if (i > 0) line += " "; // gap
        line += renderedBoxes[i][row];
      }
      // Overflow indicator on the middle row
      if (overflow > 0 && row === 3) {
        line += " " + theme.fg("dim", `+${overflow}`);
      }
      lines.push(truncateToWidth(line, termWidth));
    }

    return lines;
  }
}
