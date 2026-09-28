/*
 * Roster display mapping.
 *
 * The lobby roster arrives as KBPlayer entries (`{ id, displayName }`), but
 * the sheet/token UI components render `{ id, name }` entries. Passing the
 * lobby roster straight through leaves `name` undefined, which renders as
 * blank player entries in every assignment dropdown. Normalize at the app
 * boundary with `toDisplayRoster`.
 */

/** A roster entry as the sheet/token UI components consume it. */
export interface DisplayRosterEntry {
  id: string;
  name: string;
}

/**
 * Maps lobby players to display entries. Falls back to the player id when
 * the display name is missing or blank so the entry never renders empty.
 */
export function toDisplayRoster(
  players: readonly { id: string; displayName?: string | null }[] | null | undefined,
): DisplayRosterEntry[] {
  return (players ?? []).map((p) => ({
    id: p.id,
    name: p.displayName && p.displayName.trim().length > 0 ? p.displayName : p.id,
  }));
}
