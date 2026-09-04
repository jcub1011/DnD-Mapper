# DnD Mapper — Blazor → TypeScript/Phaser Porting Plan

This directory is the working plan for re-platforming **`KnockBox.DndMapper`** (a Blazor Server
plugin, ~31,900 lines) into **this repository** — a standalone KnockBox game built on
TypeScript, Phaser 4 and Lit 3.

The port spans three repositories — and note that **`KnockBox` and `KnockBox-Games` are two
different servers**, not one. That is the single most confusing thing about these paths:

| Repo | Role in this port |
| --- | --- |
| `…\KnockBox` | **The old world.** An ASP.NET **Blazor Server** host that loads game plugins into its own process. `host\KnockBox.DndMapper` is the legacy plugin being ported (read-only reference); `sdk\KnockBox.Platform` is where its `/blob-share/{token}` endpoint actually lives. |
| `…\Games\DnD-Mapper` (here) | **Target.** Currently an unmodified KnockBox game template. |
| `…\KnockBox-Games` | **The new world, and a different server.** The game *platform*: a relay plus a sandboxed JS authority runtime, serving games as static bundles in an iframe. Needs a new blob-share feature before multiplayer map art can work. |

Nothing is shared between the two servers — not the transport, not the storage, not the hosting
model. "Port" here means *rewrite against a different platform*, and the only genuine carry-overs
are the domain model, the `.vtf` format, and the CSS token block.

## Read these in order

| Doc | What it answers |
| --- | --- |
| [`00-decisions.md`](00-decisions.md) | What was decided, why, and what is still open. **Start here.** |
| [`01-legacy-architecture.md`](01-legacy-architecture.md) | How the Blazor app actually works. |
| [`02-target-platform.md`](02-target-platform.md) | What the KnockBox game platform allows and forbids. |
| [`03-domain-model.md`](03-domain-model.md) | The C# records, translated to TypeScript. |
| [`04-vtf-format.md`](04-vtf-format.md) | The `.vtf` file format, byte for byte. |
| [`05-rendering.md`](05-rendering.md) | Three render layers → one Phaser scene. |
| [`06-state-and-authority.md`](06-state-and-authority.md) | What syncs, how, and within what limits. |
| [`07-ui-shell.md`](07-ui-shell.md) | 32 Razor components → Lit. |
| [`08-assets-pipeline.md`](08-assets-pipeline.md) | Image upload, downscale, storage, and the `AssetSource` seam. |
| [`09-blob-share-server-spec.md`](09-blob-share-server-spec.md) | The platform feature that unblocks multiplayer map art. |
| [`10-roadmap.md`](10-roadmap.md) | Phases, ordering, acceptance criteria. |
| [`11-verification.md`](11-verification.md) | How to know each phase actually works. |

## The four things most likely to break the port

1. **Cell-unit coordinates.** Everything in the legacy domain model is measured in *grid cells*,
   not pixels — tokens at cell centres (`x.5`), images corner-anchored at whole cells, fog as a
   row-major bitset. `.vtf` fidelity depends on preserving this exactly. See
   [`03-domain-model.md`](03-domain-model.md).
2. **The 512 KiB frame ceiling, in both directions.** It is a non-configurable `const`. An
   oversized *authority broadcast* is **silently dropped** — clients simply never converge, with no
   error anywhere. An oversized *client message* closes the socket with **1009**, which no SDK
   treats as terminal, so the client reconnects and retries forever. Both failure modes are
   invisible, which is why patches are narrowed and campaign import is chunked. See
   [`06-state-and-authority.md`](06-state-and-authority.md).
3. **Map images cannot cross the relay.** This is why
   [`09-blob-share-server-spec.md`](09-blob-share-server-spec.md) is phase 0 — started early for
   its release lead time, though phases 1–4 do not wait on it.
4. **Phaser's camera zooms about its midpoint.** `camera.scrollX` is *not* the top-left world
   coordinate at any zoom other than 1, which is exactly the "synchronised wrongness" the phase
   ordering exists to prevent. See
   [`05-rendering.md`](05-rendering.md#coordinate-mapping--the-heart-of-it).

## Status

| Phase | State |
| --- | --- |
| Planning | **Complete and audited** — this document set, verified against all three repos |
| Phase 0 — blob-share platform feature | **Blocked on `Q2`** (aggregate disk quota) — needs a number before the spec is implementable |
| Phase 1 — foundation & rename | Not started |
| Phase 2 — domain + `.vtf` import | Not started |
| Phase 3 — Phaser map renderer | Not started |
| Phase 4 — authority & multiplayer sync | Not started |
| Phase 5 — UI shell | Not started |
| Phase 6+ — sheets, dice, combat, markup, display | Deferred past v1 |

Keep this table current as phases land — it is the fastest way for a future session to orient.

Two open questions gate work rather than merely informing it: **`Q2`** (blob disk quota) must be
answered before phase 0 is implementable, and **`Q1`** (hidden-token visibility) before phase 4.
`Q6` (target browsers) and `Q7` (`players[0]` is the creator) both want a one-line answer from
outside this document set.

## Conventions used in these docs

- Legacy citations look like `MapCanvas.razor.cs:412` and are relative to the legacy plugin root
  (`…\KnockBox\host\KnockBox.DndMapper`).
- Platform citations look like `WebSocketHandler.cs:950` and are relative to
  `…\KnockBox-Games\KnockBox.Server\`.
- Anything else in the `KnockBox` repo is written from that repo's root, e.g.
  `host/KnockBox/Components/App.razor:45` or `sdk/KnockBox.Platform/…`.
- SDK/addon citations like `kb-core.js:28` mean **this repo's vendored copy** under
  `addons/knockbox/`, which is what actually ships in the game. Upstream equivalents in
  `KnockBox-Games/web/` and `clients/phaser/` have drifted in places.
- Target citations are repo-relative, e.g. `src/game/types.ts:57`.
- Line numbers were accurate at the time of writing and drift. Treat a miss as "search nearby",
  not "the doc is wrong".
