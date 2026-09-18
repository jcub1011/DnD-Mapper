/**
 * Zero-dependency safe Markdown-to-HTML parser and sanitizer.
 * Converts basic Markdown formatting (headers, bold, italic, lists, quotes, code, links)
 * to sanitized HTML suitable for rendering notes.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./")
  ) {
    return true;
  }
  return false;
}

export function toSafeHtml(markdown: string): string {
  if (!markdown) return "";

  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const htmlParts: string[] = [];

  let inUl = false;
  let inOl = false;
  let inBlockquote = false;

  function closeListsAndQuotes() {
    if (inUl) {
      htmlParts.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      htmlParts.push("</ol>");
      inOl = false;
    }
    if (inBlockquote) {
      htmlParts.push("</blockquote>");
      inBlockquote = false;
    }
  }

  function formatInline(text: string): string {
    let escaped = escapeHtml(text);

    // Code inline `code`
    escaped = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold **text** or __text__
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    escaped = escaped.replace(/__([^_]+)__/g, "<strong>$1</strong>");

    // Italic *text* or _text_
    escaped = escaped.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    escaped = escaped.replace(/_([^_]+)_/g, "<em>$1</em>");

    // Strikethrough ~~text~~
    escaped = escaped.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    // Links [text](url)
    escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
      const trimmedUrl = url.trim();
      if (isSafeUrl(trimmedUrl)) {
        return `<a href="${trimmedUrl}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
      }
      return `${linkText} (${trimmedUrl})`;
    });

    return escaped;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      closeListsAndQuotes();
      continue;
    }

    // Headers # Heading
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      closeListsAndQuotes();
      const level = headerMatch[1].length;
      const content = formatInline(headerMatch[2]);
      htmlParts.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    // Blockquote > quote
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      if (inUl) { htmlParts.push("</ul>"); inUl = false; }
      if (inOl) { htmlParts.push("</ol>"); inOl = false; }
      if (!inBlockquote) {
        htmlParts.push("<blockquote>");
        inBlockquote = true;
      }
      htmlParts.push(`<p>${formatInline(quoteMatch[1])}</p>`);
      continue;
    }

    // Unordered list (- or *)
    const ulMatch = line.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      if (inBlockquote) { htmlParts.push("</blockquote>"); inBlockquote = false; }
      if (inOl) { htmlParts.push("</ol>"); inOl = false; }
      if (!inUl) {
        htmlParts.push("<ul>");
        inUl = true;
      }
      htmlParts.push(`<li>${formatInline(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list (1. 2. etc.)
    const olMatch = line.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      if (inBlockquote) { htmlParts.push("</blockquote>"); inBlockquote = false; }
      if (inUl) { htmlParts.push("</ul>"); inUl = false; }
      if (!inOl) {
        htmlParts.push("<ol>");
        inOl = true;
      }
      htmlParts.push(`<li>${formatInline(olMatch[1])}</li>`);
      continue;
    }

    // Regular paragraph
    closeListsAndQuotes();
    htmlParts.push(`<p>${formatInline(line)}</p>`);
  }

  closeListsAndQuotes();
  return htmlParts.join("");
}
