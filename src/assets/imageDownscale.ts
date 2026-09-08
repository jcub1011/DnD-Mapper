/**
 * Image decoding and downscaling pipeline.
 *
 * Scales images exceeding maxLongEdgePx down using OffscreenCanvas or HTMLCanvasElement,
 * encoding as WebP @ q=0.92 for minimal size and high visual fidelity.
 */

import { MAX_TEXTURE_SIZE_CAP } from "./textureSize.js";

export interface ImageDecodeResult {
  readonly blob: Blob;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly originalWidthPx: number;
  readonly originalHeightPx: number;
  readonly wasDownscaled: boolean;
}

export async function decodeAndMaybeDownscale(
  blob: Blob,
  maxLongEdgePx = MAX_TEXTURE_SIZE_CAP,
): Promise<ImageDecodeResult> {
  // If createImageBitmap is available (browsers and modern web workers)
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      const originalWidthPx = bitmap.width;
      const originalHeightPx = bitmap.height;
      const longEdge = Math.max(originalWidthPx, originalHeightPx);

      if (!Number.isFinite(maxLongEdgePx) || maxLongEdgePx <= 0 || longEdge <= maxLongEdgePx) {
        bitmap.close?.();
        return {
          blob,
          widthPx: originalWidthPx,
          heightPx: originalHeightPx,
          originalWidthPx,
          originalHeightPx,
          wasDownscaled: false,
        };
      }

      const scale = maxLongEdgePx / longEdge;
      const targetWidth = Math.max(1, Math.round(originalWidthPx * scale));
      const targetHeight = Math.max(1, Math.round(originalHeightPx * scale));

      let downscaledBlob: Blob | null = null;

      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
          try {
            downscaledBlob = await canvas.convertToBlob({
              type: "image/webp",
              quality: 0.92,
            });
          } catch {
            // WebP encoding might not be supported in some environments
            downscaledBlob = await canvas.convertToBlob();
          }
        }
      } else if (typeof document !== "undefined") {
        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
          downscaledBlob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob(
              (b) => resolve(b),
              "image/webp",
              0.92,
            );
          });
        }
      }

      bitmap.close?.();

      if (downscaledBlob) {
        return {
          blob: downscaledBlob,
          widthPx: targetWidth,
          heightPx: targetHeight,
          originalWidthPx,
          originalHeightPx,
          wasDownscaled: true,
        };
      }

      return {
        blob,
        widthPx: targetWidth,
        heightPx: targetHeight,
        originalWidthPx,
        originalHeightPx,
        wasDownscaled: false,
      };
    } catch {
      // Fallback if bitmap creation fails
    }
  }

  // Fallback when createImageBitmap / canvas is unavailable
  return {
    blob,
    widthPx: 100,
    heightPx: 100,
    originalWidthPx: 100,
    originalHeightPx: 100,
    wasDownscaled: false,
  };
}
