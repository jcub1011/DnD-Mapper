import { html, type TemplateResult } from "lit";

/**
 * Minimal eye / eye-slash SVG matching legacy Helpers/TokenIcons.cs.
 * Used for map visibility toggles (tokens, layers).
 */
export function eyeIcon(visible: boolean): TemplateResult {
  return visible
    ? html`<svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden="true"
        focusable="false"
      >
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"
        />
        <circle cx="8" cy="8" r="2" fill="currentColor" />
      </svg>`
    : html`<svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden="true"
        focusable="false"
      >
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"
        />
        <circle cx="8" cy="8" r="2" fill="currentColor" />
        <line
          x1="2"
          y1="14"
          x2="14"
          y2="2"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>`;
}

/**
 * Token glyph indicator matching legacy Helpers/TokenIcons.cs.
 * Circle with "A" inside vs solid filled circle.
 */
export function glyphIcon(showInitial: boolean): TemplateResult {
  return showInitial
    ? html`<svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
        />
        <text
          x="8"
          y="8"
          text-anchor="middle"
          dominant-baseline="central"
          font-family="Georgia, serif"
          font-size="8"
          font-weight="700"
          fill="currentColor"
        >
          A
        </text>
      </svg>`
    : html`<svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="currentColor"
          stroke="currentColor"
          stroke-width="1.4"
        />
      </svg>`;
}

export function trashIcon(): TemplateResult {
  return html`<svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </svg>`;
}

export function gearIcon(): TemplateResult {
  return html`<svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3" />
    <path
      d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
    />
  </svg>`;
}

export function floppyIcon(): TemplateResult {
  return html`<svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>`;
}

export function floppyPlusIcon(): TemplateResult {
  return html`<svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M15 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l5 5v6" />
    <polyline points="14 21 14 13 7 13 7 21" />
    <polyline points="7 3 7 8 13 8" />
    <line x1="19" y1="15" x2="19" y2="21" />
    <line x1="16" y1="18" x2="22" y2="18" />
  </svg>`;
}

export function uploadIcon(): TemplateResult {
  return html`<svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="14" height="14" rx="2" />
    <circle cx="8" cy="9" r="1.5" />
    <path d="M3 15l4-4 4 4 3-3 3 3" />
    <line x1="19" y1="3" x2="19" y2="9" />
    <line x1="16" y1="6" x2="22" y2="6" />
  </svg>`;
}

export function exportIcon(): TemplateResult {
  return html`<svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>`;
}

export function displayIcon(): TemplateResult {
  return html`<svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>`;
}

export function lockIcon(locked: boolean): TemplateResult {
  return locked ? html`🔒` : html`🔓`;
}
