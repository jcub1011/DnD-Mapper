/**
 * Connected notes popout window ("VS Code style" markdown editor).
 *
 * The opener writes a standalone document into an `about:blank` popup
 * (no second app boot, no extra KnockBox ticket) and the two sides stay
 * in sync over a BroadcastChannel (mirrors the `dndm-display-sync`
 * projector pattern):
 *
 * - opener -> popup: `{ type: "notes-state", sheetId, sheetName, notes, editable }`
 * - popup  -> opener: `{ type: "notes-edit", sheetId, notes }` (debounced 300ms)
 * - opener -> popup: `{ type: "notes-close", sheetId }` on teardown
 * - popup  -> opener: `{ type: "notes-leave", sheetId }` on beforeunload
 */

export const NOTES_SYNC_CHANNEL = "dndm-notes-sync";

export type NotesPopoutMode = "editor" | "split" | "preview";

export interface NotesStateMessage {
  type: "notes-state";
  sheetId: string;
  sheetName: string;
  notes: string;
  editable: boolean;
}

export interface NotesEditMessage {
  type: "notes-edit";
  sheetId: string;
  notes: string;
}

function escapeJs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    // Notes content is inlined into a <script> block — a literal
    // `</script>` in the notes would break out of it.
    .replace(/<\/script/gi, "<\\/script");
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Standalone HTML document written into the popup. No external resources. */
export function buildNotesPopoutHtml(opts: {
  sheetId: string;
  sheetName: string;
  notes: string;
  editable: boolean;
  channel?: string;
}): string {
  const channel = opts.channel ?? NOTES_SYNC_CHANNEL;
  const initialMode: NotesPopoutMode = opts.editable ? "split" : "preview";
  // The embedded renderer mirrors src/ui/panels/markdown.ts (safe subset).
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtmlAttr(opts.sheetName)} — Notes</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; display: flex; flex-direction: column; height: 100vh;
  background-color: #191512;
  background-image: linear-gradient(180deg, #1d1814 0%, #191512 55%, #14110e 100%);
  color: #ece0cc;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
}
/* ── Title bar ─────────────────────────────────────────────── */
.dndm-notes-pop-toolbar {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 14px; border-bottom: 1px solid #3a2d23;
  background: #221b16;
  box-shadow: inset 0 1px 0 rgba(232, 144, 85, 0.07);
  flex: 0 0 auto;
}
.dndm-notes-pop-title {
  font-family: "Cormorant Garamond", "EB Garamond", Georgia, serif;
  font-style: italic; font-size: 1.2rem; letter-spacing: 0.4px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dndm-notes-pop-title-suffix { color: #7a6852; font-size: 0.95rem; font-style: italic; flex: 0 0 auto; }
.dndm-notes-pop-mode {
  display: flex; gap: 2px; margin-left: auto; flex: 0 0 auto;
  background: #0c0a08; border: 1px solid #3a2d23; border-radius: 4px; padding: 2px;
}
.dndm-notes-pop-mode button {
  border: 1px solid transparent; background: transparent; color: #b29a7e;
  font: inherit; font-size: 12px; font-weight: 600; letter-spacing: 0.3px;
  padding: 4px 12px; border-radius: 3px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.dndm-notes-pop-mode button:hover:not(:disabled) { color: #f5e8d3; background: #382a1e; }
.dndm-notes-pop-mode button[aria-pressed="true"] {
  background: linear-gradient(180deg, #e89055, #c4743a 55%, #8a4a22 100%);
  border-color: #5a2e14; color: #1a1208;
  text-shadow: 0 1px 0 rgba(255, 220, 180, 0.35);
  box-shadow: inset 0 1px 0 rgba(255, 220, 180, 0.4), 0 2px 6px rgba(0, 0, 0, 0.55);
}
.dndm-notes-pop-mode button:disabled { opacity: 0.4; cursor: not-allowed; }
.dndm-notes-pop-mode button:focus-visible { outline: 2px solid #e89055; outline-offset: 1px; }
/* ── Editor groups ─────────────────────────────────────────── */
.dndm-notes-pop-main { flex: 1 1 auto; display: grid; grid-template-rows: minmax(0, 1fr); min-height: 0; overflow: hidden; background: #0c0a08; }
#editorPane, #previewPane, #divider { min-width: 0; min-height: 0; }
.dndm-notes-pop-main[data-mode="split"] { grid-template-columns: 1fr 7px 1fr; }
.dndm-notes-pop-main[data-mode="editor"] { grid-template-columns: 1fr; }
.dndm-notes-pop-main[data-mode="preview"] { grid-template-columns: 1fr; }
.dndm-notes-pop-main[data-mode="editor"] #previewPane,
.dndm-notes-pop-main[data-mode="editor"] #divider,
.dndm-notes-pop-main[data-mode="preview"] #editorPane,
.dndm-notes-pop-main[data-mode="preview"] #divider { display: none; }
#editorPane {
  width: 100%; height: 100%; resize: none; border: 0; padding: 14px 16px;
  background: #0c0a08; color: #ece0cc;
  font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13.5px; line-height: 1.65; tab-size: 4;
  caret-color: #e89055;
}
#editorPane::selection { background: rgba(196, 116, 56, 0.38); }
#editorPane:focus { outline: 1px solid #c4743a; outline-offset: -1px; }
#editorPane:disabled { color: #7a6852; }
#divider {
  position: relative; background: #221b16; border-left: 1px solid #3a2d23; border-right: 1px solid #3a2d23;
  cursor: col-resize; touch-action: none;
}
#divider::after {
  content: ""; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 3px; height: 32px; border-radius: 2px; background: #3a2d23;
}
#divider:hover::after { background: #c4743a; }
#divider:active::after { background: #e89055; box-shadow: 0 0 8px rgba(232, 144, 85, 0.6); }
#previewPane {
  padding: 14px 20px; overflow-y: auto; line-height: 1.5; font-size: 0.9rem;
  background-color: #191512;
  background-image: radial-gradient(ellipse at 50% 0%, rgba(196, 116, 56, 0.06), transparent 60%);
}
#previewPane h1, #previewPane h2, #previewPane h3 { margin: 6px 0; color: #e89055; }
#previewPane p { margin: 6px 0; }
#previewPane ul, #previewPane ol { margin: 6px 0; padding-left: 20px; }
#previewPane blockquote { margin: 6px 0; padding-left: 8px; border-left: 3px solid #e89055; color: #b29a7e; }
#previewPane code { background: rgba(0, 0, 0, 0.4); padding: 1px 4px; border-radius: 2px; font-family: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace; }
#previewPane a { color: #e89055; }
/* ── Status bar ────────────────────────────────────────────── */
.dndm-notes-pop-status {
  display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
  padding: 5px 14px; font-size: 12px; color: #b29a7e;
  border-top: 1px solid #3a2d23; background: #221b16;
}
.dndm-notes-pop-dot { width: 8px; height: 8px; border-radius: 50%; background: #6a8a52; box-shadow: 0 0 6px rgba(106, 138, 82, 0.8); flex: 0 0 auto; }
.dndm-notes-pop-status[data-state="down"] .dndm-notes-pop-dot { background: #b04a3a; box-shadow: 0 0 6px rgba(176, 74, 58, 0.8); }
.dndm-notes-pop-status .spacer { flex: 1 1 auto; }
.dndm-notes-pop-lang { color: #7a6852; letter-spacing: 0.4px; }
/* ── Scrollbars ────────────────────────────────────────────── */
#editorPane::-webkit-scrollbar, #previewPane::-webkit-scrollbar { width: 10px; height: 10px; }
#editorPane::-webkit-scrollbar-track, #previewPane::-webkit-scrollbar-track { background: transparent; }
#editorPane::-webkit-scrollbar-thumb, #previewPane::-webkit-scrollbar-thumb {
  background: #3a2d23; border-radius: 5px; border: 2px solid #0c0a08;
}
#previewPane::-webkit-scrollbar-thumb { border-color: #191512; }
#editorPane::-webkit-scrollbar-thumb:hover, #previewPane::-webkit-scrollbar-thumb:hover { background: #c4743a; }
</style>
</head>
<body>
<div class="dndm-notes-pop-toolbar">
  <span class="dndm-notes-pop-title" id="sheetTitle"></span>
  <span class="dndm-notes-pop-title-suffix">— Notes</span>
  <div class="dndm-notes-pop-mode" role="group" aria-label="View mode">
    <button type="button" data-pop-mode="editor">Editor</button>
    <button type="button" data-pop-mode="split">Split</button>
    <button type="button" data-pop-mode="preview">Preview</button>
  </div>
</div>
<div class="dndm-notes-pop-main" id="main" data-mode="${initialMode}">
  <textarea id="editorPane" aria-label="Notes markdown editor" placeholder="Character backstory, inventory, notes (Markdown supported)..." spellcheck="false"></textarea>
  <div id="divider" title="Drag to resize"></div>
  <div id="previewPane" aria-label="Notes preview"></div>
</div>
<div class="dndm-notes-pop-status" id="status" data-state="live"><span class="dndm-notes-pop-dot"></span><span id="statusText">Connected — edits sync live.</span><span class="spacer"></span><span class="dndm-notes-pop-lang">Markdown</span></div>
<script>
(function () {
  var SHEET_ID = \`${escapeJs(opts.sheetId)}\`;
  var CHANNEL = \`${escapeJs(channel)}\`;
  var editable = ${opts.editable ? "true" : "false"};
  var mode = \`${initialMode}\`;
  var editor = document.getElementById("editorPane");
  var preview = document.getElementById("previewPane");
  var main = document.getElementById("main");
  var titleEl = document.getElementById("sheetTitle");
  var statusEl = document.getElementById("status");
  var statusText = document.getElementById("statusText");
  var modeButtons = Array.prototype.slice.call(document.querySelectorAll("[data-pop-mode]"));
  var bc = ("BroadcastChannel" in window) ? new BroadcastChannel(CHANNEL) : null;
  var editTimer = 0;

  function escapeHtml(t) {
    return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function formatInline(text) {
    var e = escapeHtml(text);
    e = e.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
    e = e.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
    e = e.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    e = e.replace(/\\*([^*]+)\\*/g, "<em>$1</em>");
    e = e.replace(/_([^_]+)_/g, "<em>$1</em>");
    e = e.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    e = e.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function (m, t2, u) {
      // Mirrors isSafeUrl() in markdown.ts: the input e is already
      // HTML-escaped, so u/t2 are safe to interpolate directly
      // (re-escaping would double-encode &amp; in query strings).
      var url = t2 && u ? String(u).trim() : "";
      var low = url.toLowerCase();
      if (low.indexOf("http://") === 0 || low.indexOf("https://") === 0 || low.indexOf("mailto:") === 0 ||
          url.charAt(0) === "/" || url.indexOf("./") === 0) {
        return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + t2 + "</a>";
      }
      return t2 + " (" + url + ")";
    });
    return e;
  }
  function toSafeHtml(markdown) {
    if (!markdown) return "";
    var lines = String(markdown).replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").split("\\n");
    var out = []; var inUl = false, inOl = false, inQ = false;
    function close() {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (inQ) { out.push("</blockquote>"); inQ = false; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]; var t = line.trim();
      if (!t) { close(); continue; }
      var h = line.match(/^(#{1,6})\\s+(.*)$/);
      if (h) { close(); out.push("<h" + h[1].length + ">" + formatInline(h[2]) + "</h" + h[1].length + ">"); continue; }
      var q = line.match(/^>\\s?(.*)$/);
      if (q) {
        if (inUl) { out.push("</ul>"); inUl = false; }
        if (inOl) { out.push("</ol>"); inOl = false; }
        if (!inQ) { out.push("<blockquote>"); inQ = true; }
        out.push("<p>" + formatInline(q[1]) + "</p>"); continue;
      }
      var ul = line.match(/^[-*]\\s+(.*)$/);
      if (ul) {
        if (inQ) { out.push("</blockquote>"); inQ = false; }
        if (inOl) { out.push("</ol>"); inOl = false; }
        if (!inUl) { out.push("<ul>"); inUl = true; }
        out.push("<li>" + formatInline(ul[1]) + "</li>"); continue;
      }
      var ol = line.match(/^\\d+\\.\\s+(.*)$/);
      if (ol) {
        if (inQ) { out.push("</blockquote>"); inQ = false; }
        if (inUl) { out.push("</ul>"); inUl = false; }
        if (!inOl) { out.push("<ol>"); inOl = true; }
        out.push("<li>" + formatInline(ol[1]) + "</li>"); continue;
      }
      close(); out.push("<p>" + formatInline(line) + "</p>");
    }
    close(); return out.join("");
  }

  function applyMode(next) {
    if (!editable && next !== "preview") next = "preview";
    mode = next;
    // A divider drag writes inline column sizes for split mode; drop them
    // when leaving split so the single-pane stylesheet rule (1fr) applies.
    // Otherwise the stale 3-track inline style keeps the lone pane at a
    // fraction of the window width.
    if (next !== "split") main.style.gridTemplateColumns = "";
    main.setAttribute("data-mode", mode);
    modeButtons.forEach(function (b) {
      var isActive = b.getAttribute("data-pop-mode") === mode;
      b.setAttribute("aria-pressed", isActive ? "true" : "false");
      if (!editable && b.getAttribute("data-pop-mode") !== "preview") {
        b.setAttribute("disabled", "");
        b.title = "Read-only — preview only";
      } else {
        b.removeAttribute("disabled");
        b.removeAttribute("title");
      }
    });
  }

  function render(value) {
    preview.innerHTML = toSafeHtml(value);
  }

  // True while local keystrokes exist that the opener has not yet
  // acknowledged (via an echo equal to the editor content). While dirty,
  // incoming state is older than what the user typed and must not replace
  // the editor — otherwise fast typing gets clobbered and chars are lost.
  var dirty = false;

  function scheduleSend() {
    if (!bc || !editable) return;
    if (editTimer) window.clearTimeout(editTimer);
    editTimer = window.setTimeout(function () {
      editTimer = 0;
      // Read at fire time, not at input time, so the send is never stale.
      bc.postMessage({ type: "notes-edit", sheetId: SHEET_ID, notes: editor.value });
    }, 300);
  }

  function applyState(msg) {
    document.title = msg.sheetName + " — Notes";
    titleEl.textContent = msg.sheetName;
    editable = !!msg.editable;
    editor.disabled = !editable;
    editor.placeholder = editable
      ? "Character backstory, inventory, notes (Markdown supported)..."
      : "Read-only.";
    if (msg.notes === editor.value) {
      dirty = false;
      render(msg.notes);
    } else if (document.activeElement === editor && (dirty || editTimer)) {
      // Mid-edit: local text is newer than this state (or a send of it is
      // already in flight). Keep the editor and make sure the latest text
      // gets (re-)sent so the opener converges instead of clobbering us.
      render(editor.value);
      scheduleSend();
    } else {
      dirty = false;
      editor.value = msg.notes;
      render(msg.notes);
    }
    if (!editable) applyMode("preview");
    else if (mode !== "editor" && mode !== "split" && mode !== "preview") applyMode("split");
    else applyMode(mode);
  }

  modeButtons.forEach(function (b) {
    b.addEventListener("click", function () { applyMode(b.getAttribute("data-pop-mode")); });
  });

  editor.addEventListener("input", function () {
    dirty = true;
    render(editor.value);
    scheduleSend();
  });

  // Split divider drag.
  (function () {
    var divider = document.getElementById("divider");
    var dragging = false;
    divider.addEventListener("pointerdown", function (e) {
      if (mode !== "split") return;
      dragging = true;
      divider.setPointerCapture(e.pointerId);
    });
    divider.addEventListener("pointermove", function (e) {
      if (!dragging || mode !== "split") return;
      var rect = main.getBoundingClientRect();
      var frac = (e.clientX - rect.left) / Math.max(1, rect.width);
      frac = Math.min(0.8, Math.max(0.2, frac));
      var left = Math.round(frac * 1000) / 10;
      // fr units (not %) so the fixed 7px divider never pushes the
      // total past 100% — % + 7px overflows and pins a permanent scrollbar.
      main.style.gridTemplateColumns = left + "fr 7px " + (100 - left) + "fr";
    });
    function stop() { dragging = false; }
    divider.addEventListener("pointerup", stop);
    divider.addEventListener("pointercancel", stop);
  })();

  if (bc) {
    bc.onmessage = function (event) {
      var msg = event.data;
      if (!msg || msg.sheetId !== SHEET_ID) return;
      if (msg.type === "notes-state") applyState(msg);
      else if (msg.type === "notes-close") window.close();
    };
    window.addEventListener("beforeunload", function () {
      try { bc.postMessage({ type: "notes-leave", sheetId: SHEET_ID }); } catch (e) {}
    });
  } else {
    statusText.textContent = "Not connected (BroadcastChannel unavailable).";
    statusEl.setAttribute("data-state", "down");
  }

  // Initial paint from opener-provided values.
  titleEl.textContent = \`${escapeJs(opts.sheetName)}\`;
  editor.value = \`${escapeJs(opts.notes)}\`;
  editor.disabled = !editable;
  render(editor.value);
  applyMode(mode);
})();
</script>
</body>
</html>`;
}
