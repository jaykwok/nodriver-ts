import type { Protocol } from 'devtools-protocol';
import type { Frame } from '../page/frames.ts';
import type { WaitOptions } from '../utils.ts';

export interface SnapshotOptions {
  frameId?: string;
  limit: number;
  offset?: number;
  interactiveOnly?: boolean;
  /** Only nodes whose box intersects the tab viewport. */
  viewportOnly?: boolean;
  /** Ref of an element whose subtree is returned instead of the whole frame. */
  root?: string;
}
/** CSS pixels in the coordinates of the tab viewport; x and y are the top-left corner. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SnapshotNode {
  ref: string | null;
  role: string;
  name: string;
  depth: number;
  states: Record<string, unknown>;
  value?: string;
  url?: string;
  /** Layout box; null for nodes without layout, such as hidden elements. */
  box: Box | null;
}
export type Snapshot = {
  tabId: string;
  url: string;
  dialog: { type: string; message: string; defaultPrompt: string } | null;
  frames: Array<{ frameId: string; url: string }>;
  frameId: string;
  generation: number;
  /** Size of the tab viewport in CSS pixels; null when Chrome did not report layout. */
  viewport: { width: number; height: number } | null;
  nodes: SnapshotNode[];
  offset: number;
  truncated: boolean;
  nextOffset: number | null;
  totalNodes: number;
  capped: boolean;
};

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'listbox',
  'treeitem',
  'ListBoxOption',
  'MenuListOption',
  'PopUpButton',
]);
export const MAX_SNAPSHOT_NODES = 20_000;
type AXNode = Protocol.Accessibility.AXNode;
export const axProperty = (node: AXNode, name: string) =>
  node.properties?.find((p) => p.name === name)?.value.value;

/**
 * Selects the nodes a snapshot shows, in document order with their display depth. Unnamed
 * wrappers and static text repeating its parent's name are left out. Stops at
 * MAX_SNAPSHOT_NODES and reports `capped`.
 */
export function selectNodes(
  nodes: AXNode[],
  options: { root?: number; interactiveOnly?: boolean },
): { selected: Array<{ node: AXNode; depth: number }>; capped: boolean; rootFound: boolean } {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const starts =
    options.root !== undefined
      ? nodes.filter((n) => n.backendDOMNodeId === options.root).slice(0, 1)
      : nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  const selected: Array<{ node: AXNode; depth: number }> = [];
  const seen = new Set<string>();
  let capped = false;
  // Depth first in document order, on an explicit stack: a page can nest deeper than the call
  // stack allows.
  const stack = starts.map((node) => ({ node, depth: 0, parentName: '' })).reverse();
  for (let item = stack.pop(); item; item = stack.pop()) {
    const { node, depth, parentName } = item;
    if (seen.has(node.nodeId)) continue;
    if (selected.length >= MAX_SNAPSHOT_NODES) {
      capped = true;
      continue;
    }
    seen.add(node.nodeId);
    const role = String(node.role?.value ?? '');
    const name = String(node.name?.value ?? '');
    let include = !node.ignored && role !== 'InlineTextBox';
    // Unnamed wrappers add depth without information; text repeating its parent's name is noise.
    if (include && ['generic', 'none', 'presentation', 'LineBreak'].includes(role) && !name)
      include = false;
    if (include && role === 'StaticText' && (!name.trim() || name === parentName)) include = false;
    if (include && options.interactiveOnly)
      include = INTERACTIVE.has(role) || axProperty(node, 'focusable') === true;
    if (include) selected.push({ node, depth });
    const children = node.childIds ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const child = byId.get(children[i]!);
      if (child)
        stack.push({
          node: child,
          depth: include ? depth + 1 : depth,
          parentName: include ? name : parentName,
        });
    }
  }
  return { selected, capped, rootFound: starts.length > 0 };
}

/** Whether a box overlaps the viewport by any area. */
export function inViewport(box: Box, viewport: { width: number; height: number }): boolean {
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.x < viewport.width &&
    box.y < viewport.height &&
    box.x + box.width > 0 &&
    box.y + box.height > 0
  );
}

/**
 * Layout boxes of one document of a DOMSnapshot capture, keyed by backend node ID, moved by
 * `origin` minus the document's scroll offset. `scroll` overrides the scroll offset the capture
 * reports, for the main document whose visual viewport may be pinch-zoomed.
 */
export function layoutBoxes(
  capture: Protocol.DOMSnapshot.CaptureSnapshotResponse,
  frameId: string,
  origin: { x: number; y: number },
  scroll?: { x: number; y: number },
): Map<number, Box> {
  const boxes = new Map<number, Box>();
  const document = capture.documents?.find((d) => capture.strings[d.frameId] === frameId);
  if (!document) return boxes;
  const dx = origin.x - (scroll?.x ?? document.scrollOffsetX ?? 0);
  const dy = origin.y - (scroll?.y ?? document.scrollOffsetY ?? 0);
  const backend = document.nodes.backendNodeId ?? [];
  const { nodeIndex, bounds } = document.layout;
  for (let i = 0; i < nodeIndex.length; i++) {
    const id = backend[nodeIndex[i]!];
    const rect = bounds[i];
    if (id === undefined || !rect || boxes.has(id)) continue;
    const [x = 0, y = 0, width = 0, height = 0] = rect;
    boxes.set(id, { x: x + dx, y: y + dy, width, height });
  }
  return boxes;
}

/**
 * Top-left corner of the frame's viewport in tab viewport coordinates. DOM.getBoxModel reports
 * same-process frames in the coordinates of the session's local root, so an iframe content box
 * is added for the frame itself and for each local root on the way to the main frame.
 */
async function frameOrigin(frame: Frame, wait: WaitOptions): Promise<{ x: number; y: number }> {
  let x = 0,
    y = 0;
  for (
    let current = frame, parent = frame.parent;
    parent;
    current = parent, parent = parent.parent
  ) {
    if (current !== frame && current.session === parent.session) continue;
    const { backendNodeId } = await parent.session.sendWith('DOM.getFrameOwner', wait, {
      frameId: current.id,
    });
    const { model } = await parent.session.sendWith('DOM.getBoxModel', wait, { backendNodeId });
    x += model.content[0] ?? 0;
    y += model.content[1] ?? 0;
  }
  return { x, y };
}

/**
 * Layout boxes of a frame's nodes in tab viewport coordinates, and the tab viewport size. Reads
 * one DOMSnapshot capture of the frame's session without running page script; returns no boxes
 * when Chrome does not report layout for the frame.
 */
export async function frameGeometry(
  frame: Frame,
  wait: WaitOptions,
): Promise<{ boxes: Map<number, Box>; viewport: { width: number; height: number } | null }> {
  const main = frame.tab.mainFrame;
  const [capture, metrics, origin] = await Promise.all([
    frame.session.sendWith('DOMSnapshot.captureSnapshot', wait, { computedStyles: [] }),
    main.session.sendWith('Page.getLayoutMetrics', wait),
    frameOrigin(frame, wait),
  ]);
  const visual = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
  const viewport = visual ? { width: visual.clientWidth, height: visual.clientHeight } : null;
  if (!capture.documents) return { boxes: new Map(), viewport };
  const scroll =
    frame === main && metrics.cssVisualViewport
      ? { x: metrics.cssVisualViewport.pageX, y: metrics.cssVisualViewport.pageY }
      : undefined;
  return { boxes: layoutBoxes(capture, frame.id, origin, scroll), viewport };
}

const quote = (text: string) => JSON.stringify(text);
const round = (value: number) => Math.round(value);

/** Indented, model-friendly rendering of a snapshot, one node per line. */
export function renderSnapshot(snapshot: Snapshot): string {
  const lines = [`Tab ${snapshot.tabId} frame ${snapshot.frameId}: ${snapshot.url}`];
  if (snapshot.viewport)
    lines.push(`Viewport ${round(snapshot.viewport.width)}x${round(snapshot.viewport.height)}`);
  if (snapshot.dialog)
    lines.push(`Dialog open (${snapshot.dialog.type}): ${quote(snapshot.dialog.message)}`);
  for (const node of snapshot.nodes) {
    let line = `${'  '.repeat(Math.min(node.depth, 40))}- ${node.role || 'node'}`;
    if (node.name) line += ` ${quote(node.name)}`;
    if (node.ref) line += ` [${node.ref}]`;
    if (node.box) {
      const { x, y, width, height } = node.box;
      line += ` @${round(x)},${round(y)} ${round(width)}x${round(height)}`;
      if (snapshot.viewport && !inViewport(node.box, snapshot.viewport)) line += ' offscreen';
    }
    for (const [name, value] of Object.entries(node.states))
      if (value === true || value === 'true') line += ` ${name}`;
      else if (value !== false && value !== 'false' && value !== undefined && value !== '')
        line += ` ${name}=${String(value)}`;
    if (node.value !== undefined) line += ` value=${quote(node.value)}`;
    if (node.url) line += ` url=${node.url}`;
    lines.push(line);
  }
  const others = snapshot.frames.filter((f) => f.frameId !== snapshot.frameId);
  if (others.length && !snapshot.offset)
    lines.push(
      `Other frames (snapshot with frameId): ${others.map((f) => `${f.frameId} ${f.url}`).join('; ')}`,
    );
  if (snapshot.nextOffset !== null)
    lines.push(
      `[${snapshot.offset + snapshot.nodes.length} of ${snapshot.totalNodes}${snapshot.capped ? '+' : ''} nodes; continue with offset=${snapshot.nextOffset}]`,
    );
  else if (snapshot.capped)
    lines.push(
      `[Stopped at the limit of ${snapshot.totalNodes} nodes; snapshot a root element or another frame for the rest]`,
    );
  return lines.join('\n');
}
