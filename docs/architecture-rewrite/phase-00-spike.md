# Phase 0 — De-risk Spike (no product changes)

Goal: confirm the platform's host-mode contract before deleting anything.

## Steps

1. Remove `"serverAuthority": "authority.js"` (`export/GAME.json:18`) in a
   scratch branch and verify boot reports `authority:'host'`, creator
   `isHost:true` (`addons/knockbox/kb-core.js:145-158`).
2. Verify `sendToHost` routes to the DM player, not the server
   (`addons/knockbox/knockbox-plugin.js:164-177`,
   `addons/knockbox/knockbox-local.js:307,321`).
3. Verify the DM's `KBAuthority` host branches activate
   (`addons/knockbox/kb-authority.js:157-181,210-232`) and that guests'
   `from:'server'` forgery guards (`kb-authority.js:237,246`) go inert.
4. Confirm live-delta limits still apply to host→guest fan-out (512 KiB frame,
   30 msg/s, 1008-terminal per `docs/blazor-port/02-target-platform.md:182-261`)
   and that the save path is exempt (local IndexedDB only).

## Completion checklist

- [x] Host-mode truth table written (who is `isHost`, where `sendToHost` goes,
      who enforces kick/open-close, what `from` stamps look like)
      → folded into `docs/blazor-port/02-target-platform.md` ("Host mode" section)
- [x] DM intent → guest convergence demonstrated on scratch branch
      → `spike/phase-00-host-mode` (manifest key absent, throwaway
      `process`-peer harness 5/5 green, branch deleted)
- [x] Forgery posture (any peer can forge `delta`/`state`) documented and
      accepted under DM-trusted model → `02-target-platform.md`
- [x] Live-relay limits vs. save-path exemption documented (replaces `docs/02`
      relay section) → `02-target-platform.md` ("Host mode" section)
- [x] No product files changed on main; spike confined to scratch branch
      → verified: scratch branch deleted, `main` untouched
