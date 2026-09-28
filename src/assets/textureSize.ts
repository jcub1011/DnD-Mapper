/**
 * Probes the GPU's maximum texture size via WebGL context.
 * Clamped between 4096 and 8192 to prevent software GPU stall on large textures.
 */

export const MIN_TEXTURE_SIZE = 4096;
export const MAX_TEXTURE_SIZE_CAP = 8192;

let cachedMaxTextureSize: number | null = null;

export function probeMaxTextureSize(): number {
  if (cachedMaxTextureSize !== null) {
    return cachedMaxTextureSize;
  }

  try {
    if (typeof document === "undefined") {
      cachedMaxTextureSize = MAX_TEXTURE_SIZE_CAP;
      return cachedMaxTextureSize;
    }

    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl2") as WebGLRenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null) ??
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);

    if (gl) {
      const val = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (typeof val === "number" && val >= MIN_TEXTURE_SIZE) {
        cachedMaxTextureSize = Math.min(val, MAX_TEXTURE_SIZE_CAP);
      } else {
        cachedMaxTextureSize = MAX_TEXTURE_SIZE_CAP;
      }

      const loseExt = gl.getExtension("WEBGL_lose_context");
      try {
        loseExt?.loseContext();
      } catch {
        // Ignore errors during context release
      }
    } else {
      cachedMaxTextureSize = MAX_TEXTURE_SIZE_CAP;
    }
  } catch {
    cachedMaxTextureSize = MAX_TEXTURE_SIZE_CAP;
  }

  return cachedMaxTextureSize;
}

export function resetMaxTextureSizeForTesting(): void {
  cachedMaxTextureSize = null;
}
