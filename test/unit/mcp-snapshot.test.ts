import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import type { Protocol } from 'devtools-protocol';
import { expect } from '../fixtures/expect.ts';
import { ScriptedChrome } from '../../src/testing/index.ts';
import { OperationQueue } from '../../src/mcp/queue.ts';
import { BrowserMcpSession } from '../../src/mcp/session.ts';
import { decodePng, encodePng, MAX_PIXELS } from '../../src/mcp/png.ts';
import { drawMarks, markedScreenshot } from '../../src/mcp/marks.ts';
import { frameGeometry, layoutBoxes, renderSnapshot } from '../../src/mcp/snapshot.ts';

function pixels(width: number, height: number) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 7)) & 255;
  return { width, height, data };
}
/** A PNG built by hand, with one filter type per row, in RGB. */
function rgbPng(width: number, rows: Array<{ filter: number; bytes: number[] }>) {
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(rows.length, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.from(rows.flatMap((row) => [row.filter, ...row.bytes]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('PNG encoding round-trips RGBA pixels', () => {
  for (const [width, height] of [
    [1, 1],
    [7, 3],
    [64, 40],
  ] as const) {
    const image = pixels(width, height);
    const decoded = decodePng(encodePng(image));
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(Buffer.from(decoded.data).equals(Buffer.from(image.data))).toBe(true);
  }
});

test('PNG decoding undoes every filter type and fills alpha for RGB', () => {
  // Two pixels per row; each filtered row decodes to the same values as the row above plus one.
  const png = rgbPng(2, [
    { filter: 0, bytes: [10, 20, 30, 40, 50, 60] },
    { filter: 2, bytes: [1, 1, 1, 1, 1, 1] },
    { filter: 1, bytes: [12, 22, 32, 30, 30, 30] },
    { filter: 3, bytes: [7, 12, 17, 1, 1, 1] },
    { filter: 4, bytes: [1, 1, 1, 31, 31, 31] },
  ]);
  const { data } = decodePng(png);
  const row = (y: number) => [...data.subarray(y * 8, y * 8 + 8)];
  expect(row(0)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  expect(row(1)).toEqual([11, 21, 31, 255, 41, 51, 61, 255]);
  expect(row(2)).toEqual([12, 22, 32, 255, 42, 52, 62, 255]);
  // Average: floor((left + up) / 2) + x; for the first pixel left is 0.
  expect(row(3)).toEqual([13, 23, 33, 255, 28, 38, 48, 255]);
  // Paeth picks up for both pixels: 0 + 13 - 0 is nearest 13, 14 + 28 - 13 is nearest 28.
  expect(row(4)).toEqual([14, 24, 34, 255, 59, 69, 79, 255]);
});

test('PNG decoding refuses unsupported, damaged and oversized images', () => {
  expect(() => decodePng(Buffer.from('not a png'))).toThrow('Not a PNG image');
  const good = encodePng(pixels(2, 2));
  const damaged = Buffer.from(good);
  damaged[20]! ^= 1;
  expect(() => decodePng(damaged)).toThrow('fails its CRC');
  const sixteen = rgbPng(1, [{ filter: 0, bytes: [1, 2, 3] }]);
  sixteen[24] = 16;
  sixteen.writeUInt32BE(crc32(sixteen.subarray(12, 29)), 29);
  expect(() => decodePng(sixteen)).toThrow('Only 8-bit');
  const huge = Buffer.from(good);
  huge.writeUInt32BE(8192, 16);
  huge.writeUInt32BE(MAX_PIXELS / 8192 + 1, 20);
  huge.writeUInt32BE(crc32(huge.subarray(12, 29)), 29);
  expect(() => decodePng(huge)).toThrow('exceeds');
});

test('marks outline a box and draw its label on a tag above it', () => {
  const image = { width: 60, height: 40, data: new Uint8Array(60 * 40 * 4) };
  drawMarks(image, [{ label: 'e18', box: { x: 10, y: 20, width: 30, height: 15 } }], 1);
  const at = (x: number, y: number) => [
    ...image.data.subarray((y * 60 + x) * 4, (y * 60 + x) * 4 + 4),
  ];
  const red = [220, 38, 38, 255];
  expect(at(10, 20)).toEqual(red);
  expect(at(39, 34)).toEqual(red);
  expect(at(25, 27)).toEqual([0, 0, 0, 0]);
  // The tag is 5 * 2 + 2 * 2 = 14 pixels high, directly above the box.
  expect(at(10, 6)).toEqual(red);
  expect(at(10, 5)).toEqual([0, 0, 0, 0]);
  // The first glyph row of "e" is set: white at the padding offset.
  expect(at(12, 8)).toEqual([255, 255, 255, 255]);
});

test('layout boxes move by the frame origin and the document scroll', () => {
  const capture = {
    strings: ['main', 'child'],
    documents: [
      {
        frameId: 0,
        nodes: { backendNodeId: [1, 2] },
        layout: {
          nodeIndex: [0, 1],
          bounds: [
            [0, 0, 800, 2000],
            [100, 900, 50, 20],
          ],
        },
        scrollOffsetX: 0,
        scrollOffsetY: 800,
      },
      {
        frameId: 1,
        nodes: { backendNodeId: [5] },
        layout: { nodeIndex: [0], bounds: [[10, 30, 5, 5]] },
        scrollOffsetY: 20,
      },
    ],
  } as unknown as Protocol.DOMSnapshot.CaptureSnapshotResponse;
  expect(layoutBoxes(capture, 'main', { x: 0, y: 0 }).get(2)).toEqual({
    x: 100,
    y: 100,
    width: 50,
    height: 20,
  });
  expect(layoutBoxes(capture, 'main', { x: 0, y: 0 }, { x: 0, y: 850 }).get(2)!.y).toBe(50);
  expect(layoutBoxes(capture, 'child', { x: 200, y: 300 }).get(5)).toEqual({
    x: 210,
    y: 310,
    width: 5,
    height: 5,
  });
  expect(layoutBoxes(capture, 'other', { x: 0, y: 0 }).size).toBe(0);
});

const frameTemplate = {
  loaderId: 'loader',
  url: 'https://child.test/',
  domainAndRegistry: '',
  securityOrigin: 'https://child.test',
  mimeType: 'text/html',
  secureContextType: 'Secure',
  crossOriginIsolatedContextType: 'NotIsolated',
  gatedAPIFeatures: [],
} satisfies Omit<Protocol.Page.Frame, 'id'>;

/** A page with a button scrolled 300 px into view and an iframe holding a link. */
function scriptPage(chrome: ScriptedChrome, mainId: () => string) {
  chrome.handle('Page.getLayoutMetrics', () => ({
    cssVisualViewport: {
      pageX: 0,
      pageY: 300,
      clientWidth: 800,
      clientHeight: 600,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
    },
    cssLayoutViewport: { pageX: 0, pageY: 300, clientWidth: 800, clientHeight: 600 },
    cssContentSize: { x: 0, y: 0, width: 800, height: 3000 },
    layoutViewport: { pageX: 0, pageY: 300, clientWidth: 1600, clientHeight: 1200 },
    visualViewport: {} as never,
    contentSize: {} as never,
  }));
  chrome.handle(
    'DOMSnapshot.captureSnapshot',
    () =>
      ({
        strings: [mainId(), 'child'],
        documents: [
          {
            frameId: 0,
            nodes: { backendNodeId: [1, 2, 3] },
            layout: {
              nodeIndex: [0, 1, 2],
              bounds: [
                [0, 0, 800, 3000],
                [40, 400, 100, 30],
                [20, 2000, 50, 20],
              ],
            },
            scrollOffsetY: 300,
          },
          {
            frameId: 1,
            nodes: { backendNodeId: [9] },
            layout: { nodeIndex: [0], bounds: [[5, 15, 60, 10]] },
          },
        ],
      }) as unknown as Protocol.DOMSnapshot.CaptureSnapshotResponse,
  );
  chrome.handle('DOM.getFrameOwner', () => ({ backendNodeId: 8 }));
  chrome.handle('DOM.getBoxModel', () => ({
    model: {
      content: [300, 200, 500, 200, 500, 400, 300, 400],
      padding: [],
      border: [],
      margin: [],
      width: 200,
      height: 200,
    },
  }));
  chrome.handle(
    'Accessibility.getFullAXTree',
    (params) =>
      ({
        nodes:
          params?.frameId === 'child'
            ? [
                {
                  nodeId: 'c',
                  ignored: false,
                  role: { type: 'role', value: 'link' },
                  name: { type: 'computedString', value: 'More' },
                  backendDOMNodeId: 9,
                },
              ]
            : [
                {
                  nodeId: 'r',
                  ignored: false,
                  role: { type: 'role', value: 'RootWebArea' },
                  name: { type: 'computedString', value: 'Page' },
                  backendDOMNodeId: 1,
                  childIds: ['b', 'f'],
                },
                {
                  nodeId: 'b',
                  parentId: 'r',
                  ignored: false,
                  role: { type: 'role', value: 'button' },
                  name: { type: 'computedString', value: 'Send' },
                  backendDOMNodeId: 2,
                },
                {
                  nodeId: 'f',
                  parentId: 'r',
                  ignored: false,
                  role: { type: 'role', value: 'link' },
                  name: { type: 'computedString', value: 'Footer' },
                  backendDOMNodeId: 3,
                },
              ],
      }) as Protocol.Accessibility.GetFullAXTreeResponse,
  );
}

async function scriptedSession() {
  const chrome = await ScriptedChrome.start();
  const browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  scriptPage(chrome, () => tab.mainFrame.id);
  const received = tab.session.waitFor('Page.frameNavigated');
  chrome.emit(
    'Page.frameNavigated',
    { frame: { ...frameTemplate, id: 'child', parentId: tab.mainFrame.id }, type: 'Navigation' },
    tab.session.id,
  );
  await received;
  const session = new BrowserMcpSession({
    acquire: async () => ({ browser, queue: new OperationQueue(), release: async () => {} }),
  });
  await session.run(new AbortController().signal, async () => {}, true);
  return {
    chrome,
    browser,
    tab,
    session,
    async [Symbol.asyncDispose]() {
      await session.dispose();
      await browser.close();
      await chrome.close();
    },
  };
}

test('snapshot boxes are in tab viewport coordinates, for the main frame and an iframe', async () => {
  await using f = await scriptedSession();
  const main = await f.session.snapshot(f.tab.id, { limit: 50 }, {});
  expect(main.viewport).toEqual({ width: 800, height: 600 });
  expect(main.nodes.map((n) => [n.name, n.box])).toEqual([
    ['Page', { x: 0, y: -300, width: 800, height: 3000 }],
    ['Send', { x: 40, y: 100, width: 100, height: 30 }],
    ['Footer', { x: 20, y: 1700, width: 50, height: 20 }],
  ]);
  const text = renderSnapshot(main);
  expect(text).toContain('- button "Send" [');
  expect(text).toMatch(/- button "Send" \[e\d+\] @40,100 100x30\n/);
  expect(text).toMatch(/- link "Footer" \[e\d+\] @20,1700 50x20 offscreen/);

  const visible = await f.session.snapshot(f.tab.id, { limit: 50, viewportOnly: true }, {});
  expect(visible.nodes.map((n) => n.name)).toEqual(['Page', 'Send']);
  expect(visible.totalNodes).toBe(2);

  const child = await f.session.snapshot(f.tab.id, { limit: 50, frameId: 'child' }, {});
  // The iframe content box starts at 300,200; the child document is not scrolled.
  expect(child.nodes[0]!.box).toEqual({ x: 305, y: 215, width: 60, height: 10 });
  const owner = f.chrome.commands.find((c) => c.method === 'DOM.getFrameOwner')!;
  expect(owner.params).toEqual({ frameId: 'child' });
  expect(owner.sessionId).toBe(f.tab.session.id);
});

test('a frame geometry failure leaves boxes empty unless viewportOnly needs them', async () => {
  await using f = await scriptedSession();
  f.chrome.handle('DOMSnapshot.captureSnapshot', () => {
    throw new Error('DOMSnapshot unavailable');
  });
  const snapshot = await f.session.snapshot(f.tab.id, { limit: 50 }, {});
  expect(snapshot.viewport).toBeNull();
  expect(snapshot.nodes.every((n) => n.box === null)).toBe(true);
  expect(renderSnapshot(snapshot)).not.toContain('@');
  await expect(f.session.snapshot(f.tab.id, { limit: 50, viewportOnly: true }, {})).rejects.toThrow(
    'DOMSnapshot unavailable',
  );
  await expect(frameGeometry(f.tab.mainFrame, {})).rejects.toThrow('DOMSnapshot unavailable');
});

test('a marked screenshot labels the visible refs at device pixel positions', async () => {
  await using f = await scriptedSession();
  // Device scale factor 2: the capture is twice the CSS viewport.
  const shot = encodePng({ width: 1600, height: 1200, data: new Uint8Array(1600 * 1200 * 4) });
  f.chrome.handle('Page.captureScreenshot', () => ({ data: shot.toString('base64') }));
  const { image: png, legend } = await markedScreenshot(
    f.session,
    f.tab.id,
    'interactive',
    undefined,
    new AbortController().signal,
  );
  expect(legend).toEqual([
    {
      ref: expect.stringMatching(/^e\d+$/),
      role: 'button',
      name: 'Send',
      box: { x: 40, y: 100, width: 100, height: 30 },
    },
  ]);
  const image = decodePng(png);
  const at = (x: number, y: number) => [
    ...image.data.subarray((y * 1600 + x) * 4, (y * 1600 + x) * 4 + 4),
  ];
  // The outline is at the box corners in device pixels.
  expect(at(80, 200)).toEqual([220, 38, 38, 255]);
  expect(at(80 + 199, 200 + 59)).toEqual([220, 38, 38, 255]);
  expect(at(120, 230)).toEqual([0, 0, 0, 0]);
});
