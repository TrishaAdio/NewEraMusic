/**
 * Live terminal renderer.
 *
 * Writes tokens as they arrive and keeps a status line pinned to the bottom with
 * throughput. Code inside fenced blocks is highlighted; prose outside them is
 * dimmed, so the code is what your eye lands on.
 *
 * No dependencies. Highlighting is regex-based and intentionally approximate —
 * this is a live view, not an editor, and a real tokeniser cannot run on a
 * half-written line anyway.
 */

const ESC = '\u001b[';
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const GREY = `${ESC}90m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const BLUE = `${ESC}34m`;
const MAGENTA = `${ESC}35m`;
const CYAN = `${ESC}36m`;

const KEYWORDS =
  /\b(abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|func|function|go|if|implements|import|in|instanceof|interface|let|map|new|package|private|protected|public|range|readonly|return|satisfies|static|struct|switch|throw|try|type|typeof|var|void|while|yield|def|elif|except|lambda|pass|raise|with|nil|None|True|False|true|false|null|undefined)\b/g;

const STRINGS = /(`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
const COMMENTS = /(\/\/[^\n]*|#[^\n]*)/g;
const NUMBERS = /\b(0x[0-9a-fA-F]+|\d+\.?\d*)\b/g;
const FUNCS = /\b([a-zA-Z_$][\w$]*)(?=\()/g;

/** Highlights a complete line. Order matters: strings and comments win. */
function highlight(line: string): string {
  const holes: string[] = [];
  const stash = (text: string): string => {
    holes.push(text);
    return `\u0000${holes.length - 1}\u0000`;
  };

  let out = line
    .replace(COMMENTS, (m) => stash(`${GREY}${m}${RESET}`))
    .replace(STRINGS, (m) => stash(`${GREEN}${m}${RESET}`));

  out = out
    .replace(KEYWORDS, `${MAGENTA}$1${RESET}`)
    .replace(NUMBERS, `${YELLOW}$1${RESET}`)
    .replace(FUNCS, `${BLUE}$1${RESET}`);

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => holes[Number(i)] ?? '');
}

export interface RendererOptions {
  /** Disables ANSI when piping to a file or a non-TTY. */
  color?: boolean;
  /** Writes the status line. Off when not a TTY, since it needs cursor control. */
  statusLine?: boolean;
  out?: NodeJS.WriteStream;
}

export class LiveRenderer {
  private readonly out: NodeJS.WriteStream;
  private readonly color: boolean;
  private readonly showStatus: boolean;

  private startedAt = 0;
  private firstTokenAt: number | null = null;
  private chars = 0;
  private completionTokens: number | null = null;

  /** Buffers the current line so highlighting sees complete syntax. */
  private lineBuffer = '';
  private inFence = false;
  private fenceLang = '';
  private statusTimer: NodeJS.Timeout | undefined;

  constructor(opts: RendererOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.color = opts.color ?? this.out.isTTY ?? false;
    this.showStatus = opts.statusLine ?? this.out.isTTY ?? false;
  }

  start(model: string, baseUrl: string): void {
    this.startedAt = Date.now();
    const host = safeHost(baseUrl);
    this.write(`${DIM}${'\u2500'.repeat(60)}${RESET}\n`);
    this.write(`${BOLD}${model}${RESET} ${DIM}via ${host}${RESET}\n`);
    this.write(`${DIM}${'\u2500'.repeat(60)}${RESET}\n\n`);

    if (this.showStatus) {
      this.statusTimer = setInterval(() => this.paintStatus(), 100);
      // Do not hold the process open just to repaint a status line.
      this.statusTimer.unref?.();
    }
  }

  /** Feeds streamed content. Safe to call with partial lines or partial words. */
  push(text: string): void {
    if (this.firstTokenAt === null) this.firstTokenAt = Date.now();
    this.chars += text.length;

    this.lineBuffer += text;

    let newline: number;
    while ((newline = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      this.emitLine(line);
    }

    // Show the in-progress line immediately rather than waiting for its newline,
    // otherwise the output stutters a line at a time instead of streaming.
    if (this.lineBuffer !== '' && this.showStatus) {
      this.clearLine();
      this.write(this.paintPartial(this.lineBuffer));
    }
  }

  private emitLine(line: string): void {
    if (this.showStatus) this.clearLine();

    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      if (this.inFence) {
        this.inFence = false;
        this.write(`${DIM}\u2514${'\u2500'.repeat(48)}${RESET}\n`);
      } else {
        this.inFence = true;
        this.fenceLang = fence[1] ?? '';
        const label = this.fenceLang || 'code';
        this.write(`${DIM}\u250C\u2500 ${label} ${'\u2500'.repeat(Math.max(0, 45 - label.length))}${RESET}\n`);
      }
      return;
    }

    this.write(this.inFence ? `${highlight(line)}\n` : `${DIM}${line}${RESET}\n`);
  }

  private paintPartial(partial: string): string {
    return this.inFence ? highlight(partial) : `${DIM}${partial}${RESET}`;
  }

  setUsage(completionTokens: number): void {
    this.completionTokens = completionTokens;
  }

  finish(reason: string | null): void {
    clearInterval(this.statusTimer);

    if (this.lineBuffer !== '') {
      if (this.showStatus) this.clearLine();
      this.emitLine(this.lineBuffer);
      this.lineBuffer = '';
    }
    if (this.inFence) {
      this.write(`${DIM}\u2514${'\u2500'.repeat(48)}${RESET}\n`);
      this.inFence = false;
    }

    const elapsed = (Date.now() - this.startedAt) / 1000;
    const ttft = this.firstTokenAt ? (this.firstTokenAt - this.startedAt) / 1000 : null;
    // Falls back to a chars/4 estimate when the provider omits usage.
    const tokens = this.completionTokens ?? Math.round(this.chars / 4);
    const genSeconds = this.firstTokenAt ? (Date.now() - this.firstTokenAt) / 1000 : elapsed;
    const tps = genSeconds > 0 ? tokens / genSeconds : 0;

    this.write(`\n${DIM}${'\u2500'.repeat(60)}${RESET}\n`);
    this.write(
      [
        `${DIM}elapsed${RESET} ${elapsed.toFixed(1)}s`,
        ttft !== null ? `${DIM}ttft${RESET} ${ttft.toFixed(2)}s` : null,
        `${DIM}tokens${RESET} ${tokens}${this.completionTokens === null ? `${DIM}~${RESET}` : ''}`,
        `${DIM}rate${RESET} ${tps.toFixed(1)} t/s`,
        reason ? `${DIM}finish${RESET} ${reason}` : null,
      ]
        .filter(Boolean)
        .join(`  ${DIM}\u2502${RESET}  `) + '\n',
    );
  }

  error(message: string): void {
    clearInterval(this.statusTimer);
    if (this.showStatus) this.clearLine();
    this.write(`\n${RED}\u2715${RESET} ${message}\n`);
  }

  private paintStatus(): void {
    if (this.firstTokenAt === null) return;
    const genSeconds = (Date.now() - this.firstTokenAt) / 1000;
    const tokens = this.completionTokens ?? Math.round(this.chars / 4);
    const tps = genSeconds > 0 ? tokens / genSeconds : 0;
    // Repainted in place on the current line; the next emitLine clears it.
    this.write(`${ESC}s${CYAN}${DIM} ${tokens} tok  ${tps.toFixed(0)} t/s${RESET}${ESC}u`);
  }

  private clearLine(): void {
    if (this.showStatus) this.write(`\r${ESC}2K`);
  }

  private write(s: string): void {
    this.out.write(this.color ? s : stripAnsi(s));
  }
}

export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** Host only, so a key embedded in a URL never reaches the terminal. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}

/**
 * Extracts the largest fenced code block, for `LLM_OUT_FILE`. Falls back to the
 * whole text when the model answered without fences.
 */
export function extractCode(text: string): { code: string; lang: string } {
  const blocks = [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return { code: text.trim(), lang: '' };
  const biggest = blocks.reduce((a, b) => ((b[2]?.length ?? 0) > (a[2]?.length ?? 0) ? b : a));
  return { code: (biggest[2] ?? '').trim(), lang: biggest[1] ?? '' };
}
