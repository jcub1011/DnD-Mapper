// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultDndMapperState } from "../../game/domain";
import { toastService } from "../toast/toastService";
import {
  DISPLAY_CHANNEL,
  DisplayPopoutHost,
  ProxyAssetSource,
  asDisplayMessage,
  buildDisplayPopoutUrl,
  isDisplayPopoutLocation,
  isDisplayPopoutSearch,
} from "./displayPopout";

function fakeWindow(): Window & { postMessage: ReturnType<typeof vi.fn> } {
  return { closed: false, focus: vi.fn(), postMessage: vi.fn() } as unknown as Window & {
    postMessage: ReturnType<typeof vi.fn>;
  };
}

function deliver(source: Window, data: unknown, origin = window.location.origin): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("displayPopout protocol", () => {
  it("builds and recognises the popup route", () => {
    expect(buildDisplayPopoutUrl()).toBe("?view=display");
    expect(isDisplayPopoutSearch("?view=display")).toBe(true);
    expect(isDisplayPopoutSearch("?view=sheet&sheetId=x")).toBe(false);
    expect(isDisplayPopoutLocation({ search: "" })).toBe(false);
    expect(isDisplayPopoutLocation(undefined)).toBe(false);
  });

  it("only accepts messages tagged with the display channel", () => {
    expect(asDisplayMessage({ channel: DISPLAY_CHANNEL, type: "display-join" })).not.toBeNull();
    expect(asDisplayMessage({ type: "display-join" })).toBeNull();
    expect(asDisplayMessage({ channel: "other", type: "display-join" })).toBeNull();
    expect(asDisplayMessage("display-join")).toBeNull();
  });
});

describe("DisplayPopoutHost", () => {
  const state = createDefaultDndMapperState();
  let host: DisplayPopoutHost;
  let resolveAsset: ReturnType<typeof vi.fn<(imageId: string) => Promise<Blob | null>>>;

  beforeEach(() => {
    resolveAsset = vi.fn(async (_imageId: string): Promise<Blob | null> => new Blob(["img"]));
    host = new DisplayPopoutHost({
      getSnapshot: () => ({ state, roster: [{ id: "p1", displayName: "Pat" }] }),
      resolveAsset,
    });
  });

  afterEach(() => {
    host.dispose();
    vi.restoreAllMocks();
  });

  it("warns when the browser blocks the pop-up", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const warn = vi.spyOn(toastService, "warn");
    host.open();
    expect(host.isOpen).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("pushes state when the popup opens", () => {
    const popup = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(popup);
    host.open();
    expect(host.isOpen).toBe(true);
    expect(popup.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: DISPLAY_CHANNEL, type: "display-state", state }),
      window.location.origin,
    );
  });

  it("re-sends state when the opened popup joins without it", () => {
    // The push right after window.open lands on the popup's about:blank
    // document and is lost; the booted popup's first join must recover it.
    const popup = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(popup);
    host.open();
    popup.postMessage.mockClear();
    deliver(popup, { channel: DISPLAY_CHANNEL, type: "display-join", hasState: false });
    expect(popup.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "display-state" }),
      window.location.origin,
    );
  });

  it("adopts a popup that joins after a DM-window reload", () => {
    const popup = fakeWindow();
    // A popup that outlived the reload already has (stale) state.
    deliver(popup, { channel: DISPLAY_CHANNEL, type: "display-join", hasState: true });
    expect(host.isOpen).toBe(true);
    expect(popup.postMessage).toHaveBeenCalledTimes(1);

    // Heartbeat joins from an adopted popup with state don't re-send it.
    deliver(popup, { channel: DISPLAY_CHANNEL, type: "display-join", hasState: true });
    expect(popup.postMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores joins from another origin", () => {
    const popup = fakeWindow();
    deliver(
      popup,
      { channel: DISPLAY_CHANNEL, type: "display-join", hasState: false },
      "https://evil.example",
    );
    expect(host.isOpen).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it("answers asset requests with the image Blob", async () => {
    const popup = fakeWindow();
    deliver(popup, { channel: DISPLAY_CHANNEL, type: "display-join", hasState: false });
    deliver(popup, { channel: DISPLAY_CHANNEL, type: "display-asset-request", imageId: "img-1" });
    await flush();
    expect(resolveAsset).toHaveBeenCalledWith("img-1");
    const calls = popup.postMessage.mock.calls;
    const reply = calls[calls.length - 1]?.[0] as { type: string; blob: Blob };
    expect(reply.type).toBe("display-asset");
    expect(reply.blob).toBeInstanceOf(Blob);
  });

  it("does not serve assets to a window it has not adopted", async () => {
    const stranger = fakeWindow();
    deliver(stranger, { channel: DISPLAY_CHANNEL, type: "display-asset-request", imageId: "x" });
    await flush();
    expect(resolveAsset).not.toHaveBeenCalled();
  });

  it("forgets the popup when it leaves", () => {
    const popup = fakeWindow();
    deliver(popup, { channel: DISPLAY_CHANNEL, type: "display-join", hasState: false });
    deliver(popup, { channel: DISPLAY_CHANNEL, type: "display-leave" });
    expect(host.isOpen).toBe(false);
  });

  it("coalesces bursts of pushes into one message", async () => {
    vi.useFakeTimers();
    try {
      const popup = fakeWindow();
      deliver(popup, { channel: DISPLAY_CHANNEL, type: "display-join", hasState: false });
      popup.postMessage.mockClear();
      host.push();
      host.push();
      host.push();
      vi.runOnlyPendingTimers();
      expect(popup.postMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ProxyAssetSource", () => {
  it("requests an image once and serves it as an object URL", async () => {
    const request = vi.fn();
    const source = new ProxyAssetSource(request);
    const createUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:local/1")
      .mockReturnValueOnce("blob:local/2");

    const a = source.resolve("img-1");
    const b = source.resolve("img-1");
    expect(request).toHaveBeenCalledTimes(1);

    source.receive("img-1", new Blob(["img"]));
    await expect(a).resolves.toBe("blob:local/1");
    await expect(b).resolves.toBe("blob:local/1");
    // Cached bytes, fresh URL — the consumer revokes each URL it is given.
    await expect(source.resolve("img-1")).resolves.toBe("blob:local/2");
    expect(request).toHaveBeenCalledTimes(1);
    expect(createUrl).toHaveBeenCalledTimes(2);
    createUrl.mockRestore();
  });

  it("serves a live URL again after the consumer revoked the first (map switch back)", async () => {
    const request = vi.fn();
    const source = new ProxyAssetSource(request);
    const blob = new Blob(["img"]);
    const createUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:local/1")
      .mockReturnValueOnce("blob:local/2");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const first = source.resolve("img-1");
    source.receive("img-1", blob);
    const firstUrl = await first;
    // ensureTexture revokes the URL once Phaser has uploaded the texture.
    URL.revokeObjectURL(firstUrl!);

    const second = await source.resolve("img-1");
    expect(second).toBe("blob:local/2");
    expect(second).not.toBe(firstUrl);
    expect(createUrl).toHaveBeenLastCalledWith(blob);
    expect(request).toHaveBeenCalledTimes(1);
    createUrl.mockRestore();
    revokeUrl.mockRestore();
  });

  it("resolves null when the opener has no bytes", async () => {
    const source = new ProxyAssetSource(vi.fn());
    const p = source.resolve("missing");
    source.receive("missing", null);
    await expect(p).resolves.toBeNull();
  });
});
