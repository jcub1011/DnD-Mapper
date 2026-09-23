/*
 * Builds the Phaser global-plugin config for the launch mode.
 *
 * All three modes run the same host-authoritative path: the DM's browser holds
 * the truth behind the controller seam (MatchView's host half), and the
 * transport just routes frames. `solo` and `local-tab` use the no-server peer
 * with NO virtual server actor, so every peer gets `ready` with
 * `isHost:true/false` / `authority:'host'` exactly as the relay reports live.
 * There is no "single-player code path" that can rot.
 *
 * ── The addons are UMD ──
 * The build runs them through CommonJS interop, so each module's api is the
 * DEFAULT export and nothing is attached to globalThis. A raw <script> load hits
 * the global branch instead, so we fall back to the globals for that case.
 * `./phaserGlobal` must be imported FIRST so globalThis.Phaser is set before the
 * UMD factories evaluate (they read it, and only build the plugin classes if it's
 * there).
 */

import "./phaserGlobal";
// Importing kb-core also guarantees it is bundled and evaluated before the plugin
// module, whose factory requires it.
import KnockBoxCore from "../../addons/knockbox/kb-core.js";
import KnockBoxPluginImport from "../../addons/knockbox/knockbox-plugin.js";
import KnockBoxLocalImport from "../../addons/knockbox/knockbox-local.js";
import type { KnockBoxLocalOptions } from "../../addons/knockbox/knockbox-phaser";
import type { LaunchMode } from "./launch";

interface KnockBoxGlobals {
  KnockBoxPlugin?: unknown;
  KnockBoxLocalPlugin?: unknown;
  KnockBoxCore?: unknown;
}

const g = globalThis as unknown as KnockBoxGlobals;
// Belt-and-suspenders: make kb-core reachable via the global the UMD factories read
// on the script-tag path (harmless when the import already wired it via require()).
g.KnockBoxCore ??= (KnockBoxCore as unknown) ?? g.KnockBoxCore;

/** The real WebSocket plugin — from the module export, or the global on a script load. */
const RealPlugin: unknown = (KnockBoxPluginImport as unknown) ?? g.KnockBoxPlugin;
/** The no-server plugin. Null unless Phaser was loaded first — it subclasses BasePlugin. */
const LocalPlugin: unknown = KnockBoxLocalImport?.KnockBoxLocalPlugin ?? g.KnockBoxLocalPlugin;

/** Phaser global-plugin config for the launch mode, or null if the class is missing. */
export function knockboxPluginConfig(mode: LaunchMode): Record<string, unknown> | null {
  if (mode === "platform") {
    // The KnockBox server loads and runs authority.js itself, one instance per
    // lobby. The client passes nothing extra — `sendToHost` already routes to it.
    return RealPlugin
      ? { key: "KnockBox", plugin: RealPlugin, start: true, mapping: "knockbox" }
      : null;
  }

  // solo and local-tab: no-server peer in TRUE host mode. No `authority:`
  // option — the DM browser behind the controller is the host. (The old
  // virtual server actor is intentionally gone; `src/authority/` deletion
  // itself is deferred to Phase 05.)
  const data: KnockBoxLocalOptions = {
    mode: mode === "local-tab" ? "tab" : "solo",
  };
  return LocalPlugin
    ? { key: "KnockBox", plugin: LocalPlugin, start: true, mapping: "knockbox", data }
    : null;
}
