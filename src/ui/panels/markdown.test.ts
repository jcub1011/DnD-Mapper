import { describe, expect, it } from "vitest";
import { toSafeHtml } from "./markdown";

describe("toSafeHtml Notes Markdown Parser", () => {
  it("renders empty string for empty input", () => {
    expect(toSafeHtml("")).toBe("");
  });

  it("escapes dangerous raw HTML and prevents XSS", () => {
    const raw = `<script>alert('xss')</script><img src=x onerror="steal()">`;
    const result = toSafeHtml(raw);
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&lt;img");
  });

  it("renders headers h1 through h6", () => {
    expect(toSafeHtml("# Header 1")).toBe("<h1>Header 1</h1>");
    expect(toSafeHtml("## Header 2")).toBe("<h2>Header 2</h2>");
    expect(toSafeHtml("### Header 3")).toBe("<h3>Header 3</h3>");
  });

  it("renders bold, italic, strikethrough, and inline code", () => {
    const markdown = "This is **bold**, *italic*, ~~strikethrough~~, and `inline code`.";
    const result = toSafeHtml(markdown);
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<em>italic</em>");
    expect(result).toContain("<del>strikethrough</del>");
    expect(result).toContain("<code>inline code</code>");
  });

  it("renders blockquotes", () => {
    const markdown = "> A quote from an ancient sage";
    const result = toSafeHtml(markdown);
    expect(result).toContain("<blockquote><p>A quote from an ancient sage</p></blockquote>");
  });

  it("renders unordered and ordered lists", () => {
    const markdown = "- Item A\n- Item B\n\n1. First\n2. Second";
    const result = toSafeHtml(markdown);
    expect(result).toContain("<ul><li>Item A</li><li>Item B</li></ul>");
    expect(result).toContain("<ol><li>First</li><li>Second</li></ol>");
  });

  it("renders safe links and sanitizes dangerous schemes like javascript:", () => {
    const safeMarkdown = "[DnD Beyond](https://www.dndbeyond.com)";
    const safeResult = toSafeHtml(safeMarkdown);
    expect(safeResult).toBe(
      '<p><a href="https://www.dndbeyond.com" target="_blank" rel="noopener noreferrer">DnD Beyond</a></p>',
    );

    const dangerousMarkdown = "[Malicious](javascript:alert(1))";
    const dangerousResult = toSafeHtml(dangerousMarkdown);
    expect(dangerousResult).not.toContain("<a href");
    expect(dangerousResult).toContain("Malicious (javascript:alert(1))");
  });
});
