# Phase 5 — Build / Test / Docs Cleanup

Goal: delete the server-authority apparatus; leave a single-app build.

## Incoming from Phase 01 (do not forget)

Phase 01 deliberately left `src/authority/` (`authority.ts`, `kb.ts`,
`fakeKb.ts`), `vite.authority.config.ts`, `tsconfig.authority.json`, the
`serverAuthority` manifest key, and the server-mode test scaffolding
(`authority.test.ts`, `snapshotBudget.test.ts`, virtual-actor setup) in place
so dev/prod kept working throughout the rewrite. THIS phase deletes them per
Step 1–3 below.

## Steps

1. Delete: `src/authority/` (`authority.ts`, `kb.ts`, `fakeKb.ts`),
   `vite.authority.config.ts`, `tsconfig.authority.json`; superseded guest-only
   parts of `src/game/view.ts`; `wire.ts` frame guards (or retarget at host
   relay limits); `Patch` union remnants; server halves of
   `src/net/authorityController.ts`, `src/net/knockboxPlugin.ts` virtual actor,
   `src/net/transport.ts` server notes.
2. `package.json:7-9,21` — drop `build:authority`, simplify `build`/`typecheck`;
   `export/GAME.json:18` — delete `serverAuthority`;
   `scripts/check-manifest.mjs` — drop the authority scan;
   `eslint.config.js:41-96` — delete the sandbox block.
3. Tests — delete: `authority.test.ts`, `snapshotBudget.test.ts`,
   `authorityController.test.ts` (replaced by a host-mode suite),
   `addons.smoke.test.ts`, `view.test.ts`, `wire.test.ts`,
   `verbsAccounting.test.ts`. Keep: all pure-domain tests, `libraryService`,
   VTF, assets, UI panel tests. Rewrite: `rules.test.ts` (direct host-store
   harness), `dndm-app.test.ts` (mock host-controller), `hostInput.test.ts`,
   `campaignImport.test.ts` (no chunk round-trip).
4. Docs — rewrite `docs/blazor-port/02` (host runtime) and `06` (whole file);
   update `00` (E3/Q1/Q4/Q7, D6-D11), `07/08/09/10/11`, and the `pt-2` scope
   notes per the survey table.

## Completion checklist

- [x] Server-authority files, configs, and build passes deleted
- [x] `npm run build`, `typecheck`, `lint`, `test`, `export:game` all green
      with no authority references
- [x] Obsolete tests deleted; kept tests pass unmodified; rewritten tests
      cover host-store + host-mode sync
- [x] Manifest packs with no `serverAuthority`; no packer scan failures
- [x] Stale docs (`02`, `06`, `00`, `07-11`, `pt-2`) rewritten for host-auth

## As executed (deviations from the steps above)

Done together with the PR #3 review fixes, because the platform launch was
still running the server module while the client assumed host authority.

- **Tests kept rather than deleted.** `authorityController.test.ts` was
  already the host-mode suite: kept, harness switched to `perRecipient:true`.
  `view.test.ts` lost its guest-half cases but keeps the host-store and
  `applyLoaded` coverage. `snapshotBudget.test.ts` is pure domain and moved to
  `src/game/` (per-player snapshots are what goes on the wire now).
  `addons.smoke.test.ts` lost only its `scanAuthorityImports` case and gained a
  check that `addons/knockbox/` matches `knockbox.json`. `wire.test.ts` and
  `verbsAccounting.test.ts` are pure and still pass unmodified, so they stay.
- **`wire.ts` retargeted, not deleted.** `guardSize`/`utf8Length` are the
  relay-frame measure for the parked per-recipient patch fan-out
  (KnockBox-Games#62). `MatchView.applyIntent` no longer calls `guardSize`: the
  patch is only an accept signal and is never sent.
- **`Patch` union kept.** It is the accept signal (about 100 rule return sites)
  and the #62 hook (`projectPatchForPlayer`). Only its guest-side consumer
  (`MatchView.applyPatch`/`applySnapshot`) was deleted.
- **Guest map hydration removed** (`requestMissingMaps`, `selectMap`'s
  `requestMap`): a per-player projection always carries the active map in
  full, and an accepted `requestMap` only re-sent everyone's snapshot.
- **`check-manifest.mjs` unchanged.** It never had an authority scan.
- **Rewrite tests** (`rules`, `dndm-app`, `hostInput`, `campaignImport`)
  already had no server harness or chunk round-trip; only `dndm-app.test.ts`
  changed (hydration cases replaced).
- **DM succession removed** from `handlePlayerLeft` (locked "freeze on DM
  leave"); the host now runs the leave lifecycle via `MatchView.handlePlayerLeft`.
- The "survey table" step 4 cites was never committed; the docs were swept
  file by file instead.
