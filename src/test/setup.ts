// Setup file for Vitest happy-dom environment to support Phaser 4 device probing.

if (typeof window !== "undefined" && typeof HTMLCanvasElement !== "undefined") {
  const dummyContext = {
    canvas: {},
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowBlur: 0,
    shadowColor: "rgba(0, 0, 0, 0)",
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    fillRect: () => {},
    clearRect: () => {},
    strokeRect: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => {},
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    setTransform: () => {},
    resetTransform: () => {},
    drawImage: () => {},
    save: () => {},
    fillText: () => {},
    strokeText: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    arc: () => {},
    arcTo: () => {},
    bezierCurveTo: () => {},
    quadraticCurveTo: () => {},
    fill: () => {},
    measureText: () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }),
    transform: () => {},
    rect: () => {},
    clip: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => null,
  };

  HTMLCanvasElement.prototype.getContext = function (contextId: string) {
    if (contextId === "2d") {
      return dummyContext as unknown as RenderingContext;
    }
    return null;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
