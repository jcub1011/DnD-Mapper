/*
 * Canary for the UMD → ESM interop.
 *
 * The addons in `addons/knockbox/` are UMD, Vitest runs in Node, and what makes
 * `import X from "…/addon.js"` work here is the serve-time shim in vite.config.ts
 * (Vitest resolves its config with `command: 'serve'`). If a future Vite or Vitest
 * change breaks that, it fails HERE with an obvious message rather than as a
 * mystifying failure deep inside a gameplay test.
 *
 * Note which files are safe to import under Node: `knockbox-plugin.js` is NOT —
 * its factory throws unless Phaser is already on globalThis. `kb-core.js`,
 * `knockbox-local.js` and `kb-authority.js` all fall back to a hand-rolled
 * emitter when Phaser is absent, which is why the networking tests use those.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import KBAuthority from "../../addons/knockbox/kb-authority.js";
import KnockBoxLocal from "../../addons/knockbox/knockbox-local.js";

describe("addon interop", () => {
  it("kb-authority.js exposes KBAuthority as the default export", () => {
    expect(KBAuthority).toBeTypeOf("function");
  });

  it("knockbox-local.js exposes the Phaser-free local peer", () => {
    expect(KnockBoxLocal.KnockBoxLocalPeer).toBeTypeOf("function");
    expect(KnockBoxLocal._resetLocalHubs).toBeTypeOf("function");
  });

  it("builds no KnockBoxLocalPlugin without Phaser — which is why tests use the peer", () => {
    // The plugin subclasses Phaser.Plugins.BasePlugin, so the addon only defines
    // it when Phaser is on globalThis. In the browser `src/net/phaserGlobal.ts`
    // puts it there before these factories evaluate; under Node it stays null.
    expect(KnockBoxLocal.KnockBoxLocalPlugin).toBeNull();
  });

  it("exposes the blob API methods on KnockBoxLocalPeer (09 — Blob Share Spec)", () => {
    const peerProto = KnockBoxLocal.KnockBoxLocalPeer.prototype;
    expect(peerProto.registerBlob).toBeTypeOf("function");
    expect(peerProto.unregisterBlob).toBeTypeOf("function");
    expect(peerProto.blobUrl).toBeTypeOf("function");
  });

  it("ships the addon files byte-identical to what knockbox.json recorded", () => {
    // The addons are CLI-managed: a local edit is silently reverted by
    // `knockbox addon update` and flagged by `knockbox addon check` / pack.
    // Put game-specific behaviour in src/, never in addons/knockbox/.
    const lock = JSON.parse(readFileSync("knockbox.json", "utf8")) as {
      addons: Record<string, { files: Record<string, string> }>;
    };
    for (const addon of Object.values(lock.addons)) {
      for (const [file, sha256] of Object.entries(addon.files)) {
        // Hash LF-normalized bytes: a Windows checkout with core.autocrlf may
        // write CRLF, which is a checkout artefact, not an edit.
        const bytes = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
        const actual = createHash("sha256").update(bytes, "utf8").digest("hex");
        expect(actual, file).toBe(sha256);
      }
    }
  });
});
