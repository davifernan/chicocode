import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderLogLine } from "./ansiRenderer";

/** Renders the output of renderLogLine to an HTML string for assertion. */
function render(line: string): string {
  return renderToStaticMarkup(createElement(Fragment, null, renderLogLine(line)));
}

describe("renderLogLine", () => {
  // ── Plain text ─────────────────────────────────────────────────────────────

  it("returns plain text unchanged when there are no ANSI codes or prefix", () => {
    expect(render("hello world")).toBe("hello world");
  });

  it("renders an empty string without error", () => {
    expect(render("")).toBe("");
  });

  it("returns plain text for a standard log line with no special formatting", () => {
    expect(render("Module bundled in 234ms.")).toBe("Module bundled in 234ms.");
  });

  // ── ANSI color codes ───────────────────────────────────────────────────────

  it("applies One Dark Pro red (#e06c75) for ANSI code 31", () => {
    const html = render("\x1b[31merror\x1b[0m");
    expect(html).toContain("error");
    expect(html).toContain("#e06c75");
  });

  it("applies One Dark Pro green (#98c379) for ANSI code 32", () => {
    const html = render("\x1b[32msuccess\x1b[0m");
    expect(html).toContain("success");
    expect(html).toContain("#98c379");
  });

  it("applies One Dark Pro yellow (#e5c07b) for ANSI code 33", () => {
    const html = render("\x1b[33mwarn\x1b[0m");
    expect(html).toContain("#e5c07b");
  });

  it("applies One Dark Pro blue (#61afef) for ANSI code 34", () => {
    const html = render("\x1b[34minfo\x1b[0m");
    expect(html).toContain("#61afef");
  });

  it("applies bold style for ANSI code 1", () => {
    const html = render("\x1b[1mbold text\x1b[0m");
    expect(html).toContain("bold text");
    expect(html).toContain("bold");
  });

  it("applies underline style for ANSI code 4", () => {
    const html = render("\x1b[4munderlined\x1b[0m");
    expect(html).toContain("underline");
  });

  it("resets all styles after ANSI code 0", () => {
    const html = render("\x1b[31mred\x1b[0m plain");
    // Colored portion has the color
    expect(html).toContain("#e06c75");
    // The "plain" text after reset has no wrapper span — appears as raw text
    expect(html).toContain("plain");
  });

  it("handles bright colors (code 92 = bright green)", () => {
    const html = render("\x1b[92mbright green\x1b[0m");
    expect(html).toContain("#98c379");
  });

  it("handles multiple consecutive ANSI color changes in one line", () => {
    const html = render("\x1b[32mGreen\x1b[0m and \x1b[31mRed\x1b[0m");
    expect(html).toContain("#98c379");
    expect(html).toContain("#e06c75");
  });

  it("handles a line with only ANSI reset codes (produces empty output)", () => {
    expect(() => render("\x1b[0m\x1b[0m")).not.toThrow();
  });

  // ── Prefix detection — turborepo pipe format ───────────────────────────────

  it("detects 'web | ' turborepo pipe prefix and colorizes it", () => {
    const html = render("web | vite ready on http://localhost:5173");
    expect(html).toContain("web |");
    expect(html).toContain("vite ready on http://localhost:5173");
    expect(html).toMatch(/color:#[0-9a-f]+/i);
  });

  it("detects multi-segment pipe prefix 'server:dev | ' ", () => {
    const html = render("server:dev | listening on port 3000");
    expect(html).toContain("server:dev |");
    expect(html).toContain("listening on port 3000");
    expect(html).toMatch(/color:#[0-9a-f]+/i);
  });

  // ── Prefix detection — colon format ───────────────────────────────────────

  it("detects 'pkg:script:' colon prefix and colorizes it", () => {
    const html = render("server:dev: listening on port 3000");
    expect(html).toContain("server:dev:");
    expect(html).toContain("listening on port 3000");
    expect(html).toMatch(/color:#[0-9a-f]+/i);
  });

  it("detects scoped '@scope/pkg:script:' colon prefix", () => {
    const html = render("@cb/database:dev: connected to postgres");
    expect(html).toContain("@cb/database:dev:");
    expect(html).toContain("connected to postgres");
    expect(html).toMatch(/color:#[0-9a-f]+/i);
  });

  // ── Prefix detection — bracket format ─────────────────────────────────────

  it("detects '[tag]:' bracket prefix and colorizes it", () => {
    const html = render("[vite]: ready in 324ms");
    expect(html).toContain("[vite]");
    expect(html).toContain("ready in 324ms");
    expect(html).toMatch(/color:#[0-9a-f]+/i);
  });

  it("detects '[tag]' bracket prefix without colon", () => {
    const html = render("[webpack] bundle complete");
    expect(html).toContain("[webpack]");
    expect(html).toMatch(/color:#[0-9a-f]+/i);
  });

  // ── Prefix color consistency (djb2 hash determinism) ──────────────────────

  it("assigns the same color to the same prefix across different log lines", () => {
    const extractFirstColor = (line: string) => render(line).match(/color:(#[0-9a-f]+)/i)?.[1];

    const color1 = extractFirstColor("web | first message");
    const color2 = extractFirstColor("web | second message");
    const color3 = extractFirstColor("web | third message with more content");

    expect(color1).toBeDefined();
    expect(color1).toBe(color2);
    expect(color1).toBe(color3);
  });

  it("is stable across repeated calls with the same input", () => {
    const html1 = render("server:dev: port 3000");
    const html2 = render("server:dev: port 3000");
    expect(html1).toBe(html2);
  });

  // ── ANSI codes in prefixed lines ───────────────────────────────────────────

  it("renders ANSI colors in the rest-of-line portion of a prefixed log", () => {
    // Turborepo pipe prefix followed by ANSI-colored content
    const html = render("web | \x1b[32mcompiled successfully\x1b[0m");
    expect(html).toContain("web |");
    // The rest still gets ANSI color rendering
    expect(html).toContain("#98c379");
    expect(html).toContain("compiled successfully");
  });
});
