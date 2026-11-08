import type { Box, SnapshotNode } from './snapshot.ts';
import { decodePng, encodePng, type Image } from './png.ts';
import type { BrowserMcpSession } from './session.ts';

/** 3x5 glyphs for the characters of a ref: "e" and the digits. Each row is three bits. */
const GLYPHS: Record<string, number[]> = {
  e: [0b111, 0b101, 0b111, 0b100, 0b111],
  0: [0b111, 0b101, 0b101, 0b101, 0b111],
  1: [0b010, 0b110, 0b010, 0b010, 0b111],
  2: [0b111, 0b001, 0b111, 0b100, 0b111],
  3: [0b111, 0b001, 0b111, 0b001, 0b111],
  4: [0b101, 0b101, 0b111, 0b001, 0b001],
  5: [0b111, 0b100, 0b111, 0b001, 0b111],
  6: [0b111, 0b100, 0b111, 0b101, 0b111],
  7: [0b111, 0b001, 0b010, 0b010, 0b010],
  8: [0b111, 0b101, 0b111, 0b101, 0b111],
  9: [0b111, 0b101, 0b111, 0b001, 0b111],
};
/** Saturated colors that stay readable behind white text. */
const COLORS: Array<[number, number, number]> = [
  [220, 38, 38],
  [37, 99, 235],
  [22, 163, 74],
  [147, 51, 234],
  [234, 88, 12],
  [8, 145, 178],
  [219, 39, 119],
  [101, 163, 13],
];

export interface Mark {
  label: string;
  /** In image pixels. */
  box: Box;
}

function fill(
  image: Image,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  [r, g, b]: [number, number, number],
) {
  const left = Math.max(0, Math.floor(x0)),
    top = Math.max(0, Math.floor(y0));
  const right = Math.min(image.width, Math.ceil(x1)),
    bottom = Math.min(image.height, Math.ceil(y1));
  for (let y = top; y < bottom; y++)
    for (let x = left, o = (y * image.width + left) * 4; x < right; x++, o += 4) {
      image.data[o] = r;
      image.data[o + 1] = g;
      image.data[o + 2] = b;
      image.data[o + 3] = 255;
    }
}

/**
 * Draws an outline around each box and its label on a filled tag at the box's top-left corner,
 * above the box when there is room. Sizes follow `scale`, the image pixels per CSS pixel.
 */
export function drawMarks(image: Image, marks: Mark[], scale: number): void {
  const line = Math.max(1, Math.round(2 * scale));
  const dot = Math.max(1, Math.round(2 * scale));
  const pad = dot;
  marks.forEach(({ label, box }, index) => {
    const color = COLORS[index % COLORS.length]!;
    const { x, y, width, height } = box;
    fill(image, x, y, x + width, y + line, color);
    fill(image, x, y + height - line, x + width, y + height, color);
    fill(image, x, y, x + line, y + height, color);
    fill(image, x + width - line, y, x + width, y + height, color);
    const glyphs = [...label].map((c) => GLYPHS[c]).filter((g) => g !== undefined);
    const tagWidth = glyphs.length * 4 * dot - dot + 2 * pad;
    const tagHeight = 5 * dot + 2 * pad;
    const left = Math.min(Math.max(0, x), Math.max(0, image.width - tagWidth));
    const top = y - tagHeight >= 0 ? y - tagHeight : Math.max(0, y);
    fill(image, left, top, left + tagWidth, top + tagHeight, color);
    glyphs.forEach((rows, i) => {
      rows.forEach((bits, row) => {
        for (let column = 0; column < 3; column++)
          if (bits & (4 >> column)) {
            const px = left + pad + (i * 4 + column) * dot,
              py = top + pad + row * dot;
            fill(image, px, py, px + dot, py + dot, [255, 255, 255]);
          }
      });
    });
  });
}

export interface LegendEntry {
  ref: string;
  role: string;
  name: string;
  /** CSS pixels of the tab viewport, like snapshot boxes. */
  box: Box;
}

/**
 * Captures the viewport as PNG with the refs of the visible nodes drawn on it. The snapshot is
 * read first, so a page that changes in between can shift marks.
 */
export async function markedScreenshot(
  session: BrowserMcpSession,
  tabId: string,
  marks: 'interactive' | 'all',
  scale: number | undefined,
  signal: AbortSignal,
): Promise<{ image: Buffer; legend: LegendEntry[]; truncated: boolean }> {
  const snapshot = await session.snapshot(
    tabId,
    { interactiveOnly: marks === 'interactive', viewportOnly: true, limit: 500 },
    { signal },
  );
  const bytes = await session.tab(tabId).screenshot({ format: 'png', scale });
  const image = decodePng(bytes);
  // Image pixels per CSS pixel: covers the device scale factor and `scale` alike.
  const factor = image.width / snapshot.viewport!.width;
  const legend = snapshot.nodes
    .filter((node): node is SnapshotNode & { ref: string; box: Box } => !!node.ref && !!node.box)
    .map(({ ref, role, name, box }) => ({ ref, role, name, box }));
  drawMarks(
    image,
    legend.map(({ ref, box }) => ({
      label: ref,
      box: {
        x: box.x * factor,
        y: box.y * factor,
        width: box.width * factor,
        height: box.height * factor,
      },
    })),
    factor,
  );
  return { image: encodePng(image), legend, truncated: snapshot.truncated };
}
