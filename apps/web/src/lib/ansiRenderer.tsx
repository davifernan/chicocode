/**
 * ANSI color rendering for dev server log lines.
 *
 * Features:
 * - Parses ANSI escape sequences into styled React spans
 * - Detects monorepo/turbo style prefixes (turborepo, nx, pnpm workspaces)
 * - Assigns deterministic colors to prefixes via djb2 hash
 * - One Dark Pro color palette for ANSI codes
 */

import type { ReactNode, CSSProperties } from "react";

// ── One Dark Pro palette ──────────────────────────────────────────────────────

const ANSI_COLORS: Record<number, string> = {
  // Standard colors
  30: "#282c34",
  31: "#e06c75",
  32: "#98c379",
  33: "#e5c07b",
  34: "#61afef",
  35: "#c678dd",
  36: "#56b6c2",
  37: "#abb2bf",
  // Bright colors
  90: "#3e4452",
  91: "#e06c75",
  92: "#98c379",
  93: "#e5c07b",
  94: "#61afef",
  95: "#c678dd",
  96: "#56b6c2",
  97: "#ffffff",
};

// ── Prefix detection palette (8 distinct colors, hash-consistent) ─────────────

const PREFIX_PALETTE: readonly string[] = [
  "#61afef", // blue
  "#e06c75", // red
  "#98c379", // green
  "#e5c07b", // yellow
  "#c678dd", // magenta
  "#56b6c2", // cyan
  "#d19a66", // orange
  "#be5046", // dark red
];

/** djb2 hash — deterministic, same prefix always maps to same color */
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (((hash << 5) + hash) ^ str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function colorForPrefix(prefix: string): string {
  return PREFIX_PALETTE[djb2(prefix) % PREFIX_PALETTE.length]!;
}

// ── ANSI stripping ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_STRIP_RE = /\x1b\[[0-9;]*[mGKHF]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_STRIP_RE, "");
}

// ── Prefix detection ───────────────────────────────────────────────────────────

interface PrefixResult {
  /** The matched prefix string (plain text) */
  prefix: string;
  /** Byte offset in the *raw* (ANSI-containing) line where the prefix portion ends */
  rawRestStart: number;
}

/**
 * Finds the non-ANSI byte offset in `raw` after skipping `n` plain text characters.
 * Used to locate where the plain-text prefix ends inside the raw (ANSI-escaped) string.
 */
function rawOffsetAfterPlainChars(raw: string, n: number): number {
  let plain = 0;
  let i = 0;
  while (i < raw.length && plain < n) {
    if (raw[i] === "\x1b" && raw[i + 1] === "[") {
      i += 2;
      while (i < raw.length && raw[i] !== "m") i++;
      i++; // skip 'm'
    } else {
      plain++;
      i++;
    }
  }
  return i;
}

function detectPrefix(raw: string): PrefixResult | null {
  const plain = stripAnsi(raw);

  // Pattern 1: "prefix |" turborepo pipe format — e.g. "web | " or "server:dev | "
  // Match: any non-pipe, non-whitespace-starting text followed by " | "
  const pipeMatch = /^(\S[^|]*?)\s*\|\s/.exec(plain);
  if (pipeMatch?.[1]) {
    const prefixText = pipeMatch[1].trimEnd();
    const consumed = pipeMatch[0].length; // characters consumed from plain text
    return {
      prefix: `${prefixText} |`,
      rawRestStart: rawOffsetAfterPlainChars(raw, consumed),
    };
  }

  // Pattern 2: "@scope/pkg:script:" or "pkg:script:" — nx/turbo with colon separators
  const colonMatch = /^(@[\w/-]+:[\w.-]+:|[\w-]+:[\w.-]+:)\s*/.exec(plain);
  if (colonMatch?.[1]) {
    const consumed = colonMatch[0].length;
    return {
      prefix: colonMatch[1],
      rawRestStart: rawOffsetAfterPlainChars(raw, consumed),
    };
  }

  // Pattern 3: "[tag]:" or "[tag] " — e.g. "[vite]:", "[webpack]"
  const bracketMatch = /^(\[[^\]]+\]):?\s*/.exec(plain);
  if (bracketMatch?.[1]) {
    const consumed = bracketMatch[0].length;
    return {
      prefix: bracketMatch[1],
      rawRestStart: rawOffsetAfterPlainChars(raw, consumed),
    };
  }

  return null;
}

// ── ANSI segment parser ────────────────────────────────────────────────────────

interface AnsiSegment {
  text: string;
  color: string | null;
  bold: boolean;
  underline: boolean;
}

// eslint-disable-next-line no-control-regex
const ANSI_SEQ_RE = /\x1b\[([0-9;]*)m/g;

function parseAnsiSegments(line: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let lastIndex = 0;
  let color: string | null = null;
  let bold = false;
  let underline = false;

  ANSI_SEQ_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ANSI_SEQ_RE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, match.index), color, bold, underline });
    }
    lastIndex = ANSI_SEQ_RE.lastIndex;

    const codes = match[1] ? match[1].split(";").map(Number) : [0];
    for (const code of codes) {
      if (code === 0) {
        color = null;
        bold = false;
        underline = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 4) {
        underline = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 24) {
        underline = false;
      } else if (code === 39) {
        color = null;
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        color = ANSI_COLORS[code] ?? null;
      }
    }
  }

  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex), color, bold, underline });
  }

  return segments.filter((s) => s.text.length > 0);
}

function segmentsToNodes(segments: AnsiSegment[]): ReactNode[] {
  return segments.map((seg, i) => {
    const style: CSSProperties = {};
    if (seg.color) style.color = seg.color;
    if (seg.bold) style.fontWeight = "bold";
    if (seg.underline) style.textDecoration = "underline";

    if (Object.keys(style).length === 0) {
      return seg.text;
    }
    return (
      // eslint-disable-next-line react/no-array-index-key
      <span key={i} style={style}>
        {seg.text}
      </span>
    );
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Renders a single log line as styled React nodes.
 *
 * - Detects monorepo prefixes (turborepo, nx) and colorizes them deterministically
 * - Parses ANSI escape codes for the rest of the line
 */
export function renderLogLine(line: string): ReactNode {
  const prefixResult = detectPrefix(line);

  if (!prefixResult) {
    // No prefix — render ANSI-colored segments
    return <>{segmentsToNodes(parseAnsiSegments(line))}</>;
  }

  const { prefix, rawRestStart } = prefixResult;
  const rawRest = line.slice(rawRestStart);
  const prefixColor = colorForPrefix(prefix);

  return (
    <>
      <span style={{ color: prefixColor, fontWeight: "600" }}>{prefix} </span>
      <span style={{ opacity: 0.8 }}>{segmentsToNodes(parseAnsiSegments(rawRest))}</span>
    </>
  );
}
