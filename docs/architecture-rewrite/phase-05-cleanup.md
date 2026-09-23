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

- [ ] Server-authority files, configs, and build passes deleted
- [ ] `npm run build`, `typecheck`, `lint`, `test`, `export:game` all green
      with no authority references
- [ ] Obsolete tests deleted; kept tests pass unmodified; rewritten tests
      cover host-store + host-mode sync
- [ ] Manifest packs with no `serverAuthority`; no packer scan failures
- [ ] Stale docs (`02`, `06`, `00`, `07-11`, `pt-2`) rewritten for host-auth
