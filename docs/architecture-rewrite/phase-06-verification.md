# Phase 6 — Verification and Release Gates

Goal: prove the rewrite before release. Nothing here is optional.

## Steps

1. Tier 1 — pure rules + `projectForPlayer` matrix (no network).
2. Tier 2 — host reducer + relay sync (replaces the `fakeKb` / `LocalPeer`
   `from:server` tiers).
3. Manual passes: two-tab host loop; DM-close freeze; large-campaign
   save/load; hidden-token leak check; fog-stroke + token-drag rate test
   against 30 msg/s.
4. Perf: per-recipient serialization cost (players × filtered delta) on DM
   hardware; worst-case map vs. the 400 KB guard per recipient.

## Completion checklist

- [ ] Tier 1 green (rules + projection matrix, no network)
- [ ] Tier 2 green (host reducer + relay sync)
- [ ] Two-tab host loop verified (DM + guest converge both directions)
- [ ] DM-close freeze + reopen-restore verified
- [ ] Large-campaign save/load verified (complete, no chunk traffic)
- [ ] Leak check verified (guest holds no hidden bytes)
- [ ] Rate/frame stress verified (fog strokes, token drags, 16-player fan-out)
- [ ] Release notes document the tradeoffs: session dies with DM, DM trusted,
      fog-broadcast leak, host-uplink bottleneck
