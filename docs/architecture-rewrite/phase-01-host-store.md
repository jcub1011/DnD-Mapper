# Phase 1 — Host Store + Controller Seam

Goal: the DM's browser holds truth; the server relays blindly.

## Steps

1. `src/game/view.ts:15-26` — add the host half (`applyIntent(fromId, action)`
   delegating to `src/game/rules.ts:717-724`, plus `snapshot(forPlayerId)`).
   Keep guest `applyPatch`/`applySnapshot` untouched. Patches stay absolute.
2. `src/net/authorityController.ts:29-138` — make role-aware: host constructs
   `KBAuthority(net, fullModel)`, guests keep the replica. Flip the
   `authority!=='server'` warn (`114-125`); keep the ordering-guard re-sync
   (`60-72`).
3. `src/net/controller.ts:37-38`, `src/net/transport.ts:7-27,42-46` —
   `isHost` becomes meaningful (expose on `GameController`);
   `sendToHost` = DM player, `sendToAll` = host broadcast, lobby powers
   re-documented as host-enforced.
4. `src/net/knockboxPlugin.ts:40,70-74` — drop `authority:createAuthority`
   from `solo`/`local-tab` so dev runs true host mode; remove the
   client-bundled `createAuthority` import once the host lives behind the
   controller.
5. `src/net/launch.ts`, `src/main.ts:48-79`, `src/ui/fx/fx.ts:38-59` — no logic
   change; verify `ready(isHost:true)` ordering still holds.

## Completion checklist

- [ ] Host `applyIntent` + `snapshot` implemented and unit-tested
- [ ] Controller constructs full model on host, replica on guests
- [ ] `onReady` warn flipped; `isHost` exposed on `GameController`
- [ ] `solo`/`local-tab` run true host mode (no virtual server actor)
- [ ] Two-browser test passes: DM intent converges on both, guest intent
      validates via host, `isHost`/`authority:'host'` asserted
- [ ] Transport docs updated (`sendToHost`/`sendToAll`/lobby-power enforcement)
