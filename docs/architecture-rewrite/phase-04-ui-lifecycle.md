# Phase 4 — UI Wiring + Session Lifecycle

Goal: the shell reflects host reality; DM disconnect freezes the table.

## Steps

1. `src/ui/app/dndm-app.ts:282-345,680-836` — keep `attach`/`onStateChanged`
   shape (`send:860-862` stays the sole intent site; `changed`/`roster`
   subscriptions stay). Rebind `isDm:353-359` to the host id. Verify the DM's
   own `HostInputTracker` keys (`hostInput.ts:1-158`, wiring `297-304`) loop
   back without double-apply.
2. Panels need no intent changes (dumb props + callbacks); repoint
   `panels/dndm-saves-panel.ts:156-175` to direct-apply; rewrite
   `panels/dndm-sheet-popout-view.ts:163-193` no-op stubs against the host RPC.
3. `lobby/dndm-lobby.ts:1050-1067` — `startSession`/kick/`setLobbyOpen` become
   host-enforced.
4. Build the freeze UX: DM `player-left(host)` → pause overlay ("waiting for
   DM"); DM return → `full` re-sync + blob re-resolve.

## Completion checklist

- [ ] `isDm` follows the host id; all tool/panel gates verified
- [ ] `send` remains the sole intent entry; no panel touches the transport
- [ ] DM key streaming verified (no double-apply, throttle intact)
- [ ] Saves panel loads via direct-apply; sheet-popout stubs rewritten
- [ ] DM-close freezes guests with overlay (no crash, no silent stall)
- [ ] DM-reopen restores via autosave prompt + `full` re-sync
