import type { Protocol } from 'devtools-protocol';
import type { Frame } from '../page/frames.ts';
import { checkException } from '../page/frames.ts';
import type { Session } from '../protocol/connection.ts';
import { Element } from './element.ts';
import { StaleElementError } from '../errors.ts';
import { budget, type WaitOptions } from '../utils.ts';
export type Selector =
  string | { css: string } | { xpath: string } | { text: string; exact?: boolean };
/** `timeout` and `signal` bound the whole query, including every CDP request it makes. */
export interface QueryOptions extends WaitOptions {
  pierce?: boolean;
  visible?: boolean;
  /** At most this many matches; 10,000 by default. */
  limit?: number;
}
let queryId = 0;
/** How long a "no closed shadow roots" DOM scan is trusted for the same document generation. */
const CLOSED_SHADOW_SCAN_TTL = 1000;
interface Scan {
  session: Session;
  generation: number;
  revision: number;
  at: number;
  /** The document and its shadow roots, when some of them are closed. */
  roots?: Protocol.DOM.BackendNodeId[];
}
const scans = new WeakMap<Frame, Scan>();
const revisions = new WeakMap<Session, { value: number }>();
const STRUCTURAL_EVENTS = new Set([
  'DOM.documentUpdated',
  'DOM.setChildNodes',
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.shadowRootPushed',
  'DOM.shadowRootPopped',
]);
function domRevision(session: Session): { value: number } {
  let revision = revisions.get(session);
  if (!revision) {
    revision = { value: 0 };
    revisions.set(session, revision);
    const current = revision;
    session.onAny((event) => {
      if (STRUCTURAL_EVENTS.has(event.method)) current.value++;
    });
  }
  return revision;
}
function documentFor(node: Protocol.DOM.Node, frameId: string): Protocol.DOM.Node | undefined {
  if (node.nodeType === 9 && node.frameId === frameId) return node;
  if (node.contentDocument) {
    if (node.frameId === frameId || node.contentDocument.frameId === frameId)
      return node.contentDocument;
    const found = documentFor(node.contentDocument, frameId);
    if (found) return found;
  }
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = documentFor(child, frameId);
    if (found) return found;
  }
  return undefined;
}
/** The frame's document in a tree from DOM.getDocument of the frame's session. */
function frameDocument(
  root: Protocol.DOM.Node,
  frame: Frame,
  session: Session,
): Protocol.DOM.Node | undefined {
  return (
    documentFor(root, frame.id) ??
    (frame === frame.manager.mainFrame || frame.parent?.session !== session ? root : undefined)
  );
}
function hasClosedShadow(node: Protocol.DOM.Node): boolean {
  // contentDocument belongs to a separate Frame API, even when in the same process.
  for (const shadow of node.shadowRoots ?? [])
    if (shadow.shadowRootType === 'closed' || hasClosedShadow(shadow)) return true;
  return (node.children ?? []).some(hasClosedShadow);
}
/** `node` and every open or closed shadow root below it, in document order. */
function shadowRoots(node: Protocol.DOM.Node): Protocol.DOM.BackendNodeId[] {
  const roots = [node.backendNodeId];
  const visit = (node: Protocol.DOM.Node) => {
    for (const shadow of node.shadowRoots ?? []) {
      if (shadow.shadowRootType !== 'user-agent') roots.push(shadow.backendNodeId);
      visit(shadow);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(node);
  return roots;
}
// Runs in the isolated world. `roots` are searched in order; with `walk`, open shadow roots below
// them are added too (the isolated world never sees closed roots).
const SEARCH = `function(spec, visible, limit, walk, useDocument, ...extra) {
  const roots = [useDocument ? document : this, ...extra];
  if (walk) {
    const add = r => { if (r.shadowRoot && !roots.includes(r.shadowRoot)) { roots.push(r.shadowRoot); add(r.shadowRoot); } for (const e of r.querySelectorAll('*')) if (e.shadowRoot) { roots.push(e.shadowRoot); add(e.shadowRoot); } };
    for (const r of [...roots]) add(r);
  }
  const norm = s => s.replace(/\\s+/g, ' ').trim();
  const texts = new Map();
  const textOf = e => { let t = texts.get(e); if (t === undefined) { t = norm(e.textContent || ''); texts.set(e, t); } return t; };
  const shown = e => { const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && e.getClientRects().length > 0; };
  let items = [];
  for (const root of roots) {
    if (spec.css !== undefined) items.push(...root.querySelectorAll(spec.css));
    else if (spec.xpath !== undefined) {
      const doc = root.ownerDocument || root;
      const results = doc.evaluate(spec.xpath, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
      for (let i = 0; i < results.snapshotLength; i++) { const e = results.snapshotItem(i); if (e.nodeType === 1) items.push(e); }
    } else {
      const text = norm(spec.text);
      const match = e => { if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(e.tagName)) return false; const t = textOf(e); return spec.exact ? t === text : t.includes(text); };
      for (const e of root.querySelectorAll('*')) if (match(e) && !Array.from(e.children).some(match)) items.push(e);
    }
    if (spec.text === undefined && !visible && items.length >= limit) break;
  }
  if (spec.text !== undefined) items.sort((a, b) => textOf(a).length - textOf(b).length);
  const selected = [];
  for (const e of items) { if (selected.length >= limit) break; if (!visible || shown(e)) selected.push(e); }
  return selected;
}`;
/**
 * The frame document and its shadow roots when some of them are closed, which only a CDP DOM scan
 * can reach; undefined when there are none. DOM.getDocument is costly on large pages: a negative
 * result is reused briefly, a positive one until the DOM structure changes.
 */
async function closedShadowRoots(
  frame: Frame,
  session: Session,
  step: () => WaitOptions,
): Promise<Protocol.DOM.BackendNodeId[] | undefined> {
  const revision = domRevision(session).value;
  const cached = scans.get(frame);
  if (
    cached &&
    cached.session === session &&
    cached.revision === revision &&
    cached.generation === frame.generation &&
    (cached.roots || performance.now() - cached.at < CLOSED_SHADOW_SCAN_TTL)
  )
    return cached.roots;
  const generation = frame.generation;
  const { root } = await session.sendWith('DOM.getDocument', step(), { depth: -1, pierce: true });
  const document = frameDocument(root, frame, session);
  const roots = document && hasClosedShadow(document) ? shadowRoots(document) : undefined;
  if (generation === frame.generation && revision === domRevision(session).value)
    scans.set(frame, { session, generation, revision, at: performance.now(), roots });
  return roots;
}
export async function query(
  frame: Frame,
  selector: Selector,
  options: QueryOptions = {},
  scope?: Protocol.DOM.BackendNodeId,
): Promise<Element[]> {
  if (frame.detached) throw new StaleElementError('Cannot query detached frame');
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1))
    throw new RangeError('limit must be a positive integer');
  const session = frame.session;
  const generation = frame.generation;
  const step = budget(options, 'query');
  const context = await frame.context('isolated', step());
  const normalized = typeof selector === 'string' ? { css: selector } : selector;
  const pierce = options.pierce !== false && !('xpath' in normalized);
  const group = `nodriver-query-${++queryId}`;
  const args = (walk: boolean, useDocument: boolean) => [
    { value: normalized },
    { value: options.visible ?? 'text' in normalized },
    { value: options.limit ?? 10_000 },
    { value: walk },
    { value: useDocument },
  ];
  try {
    let result: Protocol.Runtime.CallFunctionOnResponse;
    const closed = pierce ? await closedShadowRoots(frame, session, step) : undefined;
    if (!closed) {
      // Fast path: one call in the isolated world over the document and its open shadow roots.
      let objectId: string | undefined;
      if (scope)
        objectId = (
          await session.sendWith('DOM.resolveNode', step(), {
            backendNodeId: scope,
            executionContextId: context,
            objectGroup: group,
          })
        ).object.objectId;
      result = await session.sendWith('Runtime.callFunctionOn', step(), {
        ...(objectId ? { objectId } : { executionContextId: context }),
        objectGroup: group,
        functionDeclaration: SEARCH,
        arguments: args(pierce, !objectId),
      });
    } else {
      // Closed shadow roots exist: resolve every root CDP reports and search them in one call.
      const roots = scope
        ? shadowRoots(
            (
              await session.sendWith('DOM.describeNode', step(), {
                backendNodeId: scope,
                depth: -1,
                pierce: true,
              })
            ).node,
          )
        : closed;
      const objects = await Promise.all(
        roots.map(
          async (backendNodeId) =>
            (
              await session.sendWith('DOM.resolveNode', step(), {
                backendNodeId,
                executionContextId: context,
                objectGroup: group,
              })
            ).object.objectId!,
        ),
      );
      result = await session.sendWith('Runtime.callFunctionOn', step(), {
        objectId: objects[0]!,
        objectGroup: group,
        functionDeclaration: SEARCH,
        arguments: [...args(false, false), ...objects.slice(1).map((objectId) => ({ objectId }))],
      });
    }
    checkException(result);
    const matches: Element[] = [];
    if (result.result.objectId) {
      const { result: properties } = await session.sendWith('Runtime.getProperties', step(), {
        objectId: result.result.objectId,
        ownProperties: true,
      });
      const items = properties
        .filter((p) => /^\d+$/.test(p.name) && p.value?.objectId)
        .sort((a, b) => Number(a.name) - Number(b.name));
      const nodes = await Promise.all(
        items.map((p) =>
          session.sendWith('DOM.describeNode', step(), { objectId: p.value!.objectId! }),
        ),
      );
      for (const { node } of nodes)
        matches.push(new Element(frame, node.backendNodeId, generation, session));
    }
    if (generation !== frame.generation || session !== frame.session)
      throw new StaleElementError('Document changed during query');
    return options.limit ? matches.slice(0, options.limit) : matches;
  } finally {
    // Cleanup has its own short deadline and never delays the caller's timeout or abort.
    void session
      .sendWith('Runtime.releaseObjectGroup', { timeout: 1000 }, { objectGroup: group })
      .catch(() => {});
  }
}
