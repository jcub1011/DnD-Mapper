# Architecture Rewrite — Server-Auth → Host-Auth (Issue #2)

Locked decisions: **freeze on DM leave** (no host migration), **DM trusted**
(no server anti-cheat), **true per-player filtering**. Code churn accepted.

Target shape: the DM's browser holds all game state at all times. The KnockBox
server becomes a dumb relay/router (`sendToHost` → DM player, `sendToAll` →
host broadcast). Saves are pure-local IndexedDB writes with zero network.
Players receive only projected deltas via directed `sendTo()`.

Key sources: `export/GAME.json:18` (`serverAuthority` opt-in),
`src/authority/authority.ts`, `src/net/authorityController.ts`,
`src/net/transport.ts`, `src/net/knockboxPlugin.ts`,
`src/game/rules.ts` + `visibility.ts`, `src/game/campaignImport.ts`,
`src/storage/libraryService.ts`, `src/ui/app/dndm-app.ts`,
`docs/blazor-port/02-target-platform.md`, `docs/blazor-port/06-state-and-authority.md`.

Phases:

| Phase | File | Goal |
|---|---|---|
| 0 | `phase-00-spike.md` | De-risk: confirm host-mode platform contract |
| 1 | `phase-01-host-store.md` | DM browser holds truth; controller seam is role-aware |
| 2 | `phase-02-projection.md` | True per-player filtering (`projectForPlayer`) |
| 3 | `phase-03-save-load.md` | Save/load collapse to pure-local |
| 4 | `phase-04-ui-lifecycle.md` | UI wiring + freeze-on-leave UX |
| 5 | `phase-05-cleanup.md` | Build / test / docs cleanup |
| 6 | `phase-06-verification.md` | Verification and release gates |

Work phases in order. Each phase lists steps plus a completion checklist that
must be fully checked before moving on.
