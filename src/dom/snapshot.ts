import type { Protocol } from 'devtools-protocol';

/** Axis-aligned rectangle decoded from a `DOMSnapshot` 4-tuple `[x, y, width, height]`. */
export interface DOMSnapshotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Uniform or per-axis positive scale divisor applied to decoded `DOMSnapshot` rectangles. */
export type DOMSnapshotScale = number | { readonly x: number; readonly y: number };

export interface ParseDOMSnapshotOptions {
  /**
   * CSS property names in the exact order passed to
   * `DOMSnapshot.captureSnapshot({ computedStyles })`. Required to decode `node.styles` and
   * `node.style(name)` by property name.
   */
  computedStyles?: readonly string[];
  /**
   * Positive scale divisor (uniform number or `{ x, y }` per-axis divisor) applied to decoded
   * rectangles (`bounds`, `offsetRect`, `scrollRect`, `clientRect`) — for example
   * `devicePixelRatio` when converting physical coordinates to CSS pixels. Defaults to `1`.
   */
  cssScale?: DOMSnapshotScale;
  /**
   * Omit empty/unpopulated computed style entries (`-1` or `''` in Chrome's `DOMSnapshot` string
   * table) from `node.styles` and return `undefined` from `node.style(name)`.
   *
   * Defaults to `false` (unpopulated style slots decode to `''`, matching CDP string-table lookup).
   * Setting `true` makes nullish fallbacks such as `Number(node.styles.opacity ?? '1')` safe
   * against Chrome leaving unused computed styles empty.
   */
  omitEmptyStyles?: boolean;
}

function indexRare(data: { index: number[]; value: number[] } | undefined): Map<number, number> {
  const map = new Map<number, number>();
  if (!data) return map;
  const len = Math.min(data.index.length, data.value.length);
  for (let i = 0; i < len; i++) map.set(data.index[i]!, data.value[i]!);
  return map;
}

function indexRareBoolean(data: Protocol.DOMSnapshot.RareBooleanData | undefined): Set<number> {
  return new Set<number>(data?.index ?? []);
}

function decodeRect(
  tuple: Protocol.DOMSnapshot.Rectangle | undefined,
  scaleX: number,
  scaleY: number,
): DOMSnapshotRect | undefined {
  if (!tuple || tuple.length < 4) return undefined;
  const [x, y, width, height] = tuple;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  )
    return undefined;
  return scaleX === 1 && scaleY === 1
    ? { x, y, width, height }
    : { x: x / scaleX, y: y / scaleY, width: width / scaleX, height: height / scaleY };
}

/** Lazy, zero-side-effect read-only view of one node in a `DOMSnapshot.DocumentSnapshot`. */
export class DOMSnapshotNodeView {
  readonly document: DOMSnapshotDocumentView;
  readonly documentIndex: number;
  readonly nodeIndex: number;
  private cachedAttributes?: Readonly<Record<string, string>>;
  private cachedStyles?: Readonly<Record<string, string>>;

  /** @internal */
  constructor(document: DOMSnapshotDocumentView, nodeIndex: number) {
    this.document = document;
    this.documentIndex = document.index;
    this.nodeIndex = nodeIndex;
  }

  get nodeType(): number {
    return this.document.raw.nodes.nodeType?.[this.nodeIndex] ?? 0;
  }

  get nodeName(): string {
    return this.document.snapshot.string(this.document.raw.nodes.nodeName?.[this.nodeIndex]);
  }

  /** Lowercase element tag name for `ELEMENT_NODE` (`nodeType === 1`), or `''` for other nodes. */
  get tag(): string {
    return this.nodeType === 1 ? this.nodeName.toLowerCase() : '';
  }

  get nodeValue(): string {
    return this.document.snapshot.string(this.document.raw.nodes.nodeValue?.[this.nodeIndex]);
  }

  /** Parent node index within this document, or `-1` for roots. */
  get parentIndex(): number {
    return this.document.raw.nodes.parentIndex?.[this.nodeIndex] ?? -1;
  }

  get parent(): DOMSnapshotNodeView | undefined {
    const idx = this.parentIndex;
    return idx >= 0 ? this.document.node(idx) : undefined;
  }

  get childIndexes(): readonly number[] {
    return this.document.childrenOf(this.nodeIndex);
  }

  get children(): readonly DOMSnapshotNodeView[] {
    return this.childIndexes
      .map((idx) => this.document.node(idx))
      .filter((n): n is DOMSnapshotNodeView => n !== undefined);
  }

  get backendNodeId(): Protocol.DOM.BackendNodeId | undefined {
    return this.document.raw.nodes.backendNodeId?.[this.nodeIndex];
  }

  get shadowRootType(): string | undefined {
    return this.document.rareString('shadowRootType', this.nodeIndex);
  }

  get pseudoType(): string | undefined {
    return this.document.rareString('pseudoType', this.nodeIndex);
  }

  get pseudoIdentifier(): string | undefined {
    return this.document.rareString('pseudoIdentifier', this.nodeIndex);
  }

  /** `<textarea>` text value when present in `nodes.textValue`. */
  get textValue(): string | undefined {
    return this.document.rareString('textValue', this.nodeIndex);
  }

  /** `<input>` value when present in `nodes.inputValue`. */
  get inputValue(): string | undefined {
    return this.document.rareString('inputValue', this.nodeIndex);
  }

  /** Unified form control value (`inputValue ?? textValue`), covering `<input>` and `<textarea>`. */
  get formValue(): string | undefined {
    return this.inputValue ?? this.textValue;
  }

  get inputChecked(): boolean {
    return this.document.rareBoolean('inputChecked', this.nodeIndex);
  }

  get optionSelected(): boolean {
    return this.document.rareBoolean('optionSelected', this.nodeIndex);
  }

  get isClickable(): boolean {
    return this.document.rareBoolean('isClickable', this.nodeIndex);
  }

  get currentSourceURL(): string | undefined {
    return this.document.rareString('currentSourceURL', this.nodeIndex);
  }

  get originURL(): string | undefined {
    return this.document.rareString('originURL', this.nodeIndex);
  }

  /** Index into `snapshot.documents` for iframe/frame owners with an in-snapshot document. */
  get childDocumentIndex(): number | undefined {
    return this.document.contentDocumentIndexOf(this.nodeIndex);
  }

  get childDocument(): DOMSnapshotDocumentView | undefined {
    const idx = this.childDocumentIndex;
    return idx !== undefined ? this.document.snapshot.documents[idx] : undefined;
  }

  /** Element attributes decoded lazily from flattened `[nameIndex, valueIndex, ...]` pairs. */
  get attributes(): Readonly<Record<string, string>> {
    if (this.cachedAttributes) return this.cachedAttributes;
    const raw = this.document.raw.nodes.attributes?.[this.nodeIndex];
    const out: Record<string, string> = Object.create(null);
    if (raw) {
      const snap = this.document.snapshot;
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const key = snap.string(raw[i]);
        if (key) out[key] = snap.string(raw[i + 1]);
      }
    }
    this.cachedAttributes = Object.freeze(out);
    return this.cachedAttributes;
  }

  /** Reads one attribute by name (exact match, with lowercase fallback for HTML names). */
  attribute(name: string): string | undefined {
    const attrs = this.attributes;
    if (Object.hasOwn(attrs, name)) return attrs[name];
    const lower = name.toLowerCase();
    return Object.hasOwn(attrs, lower) ? attrs[lower] : undefined;
  }

  /** First matching layout index in `document.raw.layout`, or `undefined` if unlaid out. */
  get layoutIndex(): number | undefined {
    return this.document.layoutIndexOf(this.nodeIndex);
  }

  /** All layout indices referencing this node (e.g. inline elements split across lines). */
  get layoutIndexes(): readonly number[] {
    return this.document.layoutIndexesOf(this.nodeIndex);
  }

  get hasLayout(): boolean {
    return this.layoutIndex !== undefined;
  }

  get bounds(): DOMSnapshotRect | undefined {
    const idx = this.layoutIndex;
    const snap = this.document.snapshot;
    return idx === undefined
      ? undefined
      : decodeRect(this.document.raw.layout.bounds?.[idx], snap.cssScaleX, snap.cssScaleY);
  }

  /** All decoded layout bounding boxes for this node (e.g. inline spans split across lines). */
  get allBounds(): readonly DOMSnapshotRect[] {
    const rects: DOMSnapshotRect[] = [];
    const snap = this.document.snapshot;
    const rawBounds = this.document.raw.layout.bounds;
    if (!rawBounds) return rects;
    for (const idx of this.layoutIndexes) {
      const rect = decodeRect(rawBounds[idx], snap.cssScaleX, snap.cssScaleY);
      if (rect) rects.push(rect);
    }
    return rects;
  }

  get offsetRect(): DOMSnapshotRect | undefined {
    const idx = this.layoutIndex;
    const snap = this.document.snapshot;
    return idx === undefined
      ? undefined
      : decodeRect(this.document.raw.layout.offsetRects?.[idx], snap.cssScaleX, snap.cssScaleY);
  }

  get scrollRect(): DOMSnapshotRect | undefined {
    const idx = this.layoutIndex;
    const snap = this.document.snapshot;
    return idx === undefined
      ? undefined
      : decodeRect(this.document.raw.layout.scrollRects?.[idx], snap.cssScaleX, snap.cssScaleY);
  }

  get clientRect(): DOMSnapshotRect | undefined {
    const idx = this.layoutIndex;
    const snap = this.document.snapshot;
    return idx === undefined
      ? undefined
      : decodeRect(this.document.raw.layout.clientRects?.[idx], snap.cssScaleX, snap.cssScaleY);
  }

  get layoutText(): string | undefined {
    const idx = this.layoutIndex;
    if (idx === undefined) return undefined;
    const strIdx = this.document.raw.layout.text?.[idx];
    return strIdx !== undefined && strIdx >= 0 ? this.document.snapshot.string(strIdx) : undefined;
  }

  get paintOrder(): number | undefined {
    const idx = this.layoutIndex;
    return idx === undefined ? undefined : this.document.raw.layout.paintOrders?.[idx];
  }

  get isStackingContext(): boolean {
    const idx = this.layoutIndex;
    return idx !== undefined && this.document.isStackingContextLayout(idx);
  }

  get blendedBackgroundColor(): string | undefined {
    const idx = this.layoutIndex;
    if (idx === undefined) return undefined;
    const strIdx = this.document.raw.layout.blendedBackgroundColors?.[idx];
    return strIdx !== undefined && strIdx >= 0 ? this.document.snapshot.string(strIdx) : undefined;
  }

  get textColorOpacity(): number | undefined {
    const idx = this.layoutIndex;
    return idx === undefined ? undefined : this.document.raw.layout.textColorOpacities?.[idx];
  }

  /**
   * Decoded computed styles keyed by `ParseDOMSnapshotOptions.computedStyles`. Returns an empty
   * object when the node has no layout entry or `computedStyles` was not supplied.
   *
   * By default (`omitEmptyStyles: false`), Chrome's unpopulated style slots (`-1` or `''`) are
   * preserved as empty strings (`''`). Pass `{ omitEmptyStyles: true }` to `parseDOMSnapshot()` to
   * omit empty entries so `styles.opacity ?? '1'` falls back cleanly.
   */
  get styles(): Readonly<Record<string, string>> {
    if (this.cachedStyles) return this.cachedStyles;
    const out: Record<string, string> = Object.create(null);
    const idx = this.layoutIndex;
    const names = this.document.snapshot.computedStyles;
    const indices = idx !== undefined ? this.document.raw.layout.styles?.[idx] : undefined;
    if (indices && names.length) {
      const snap = this.document.snapshot;
      const omitEmpty = snap.omitEmptyStyles;
      const len = Math.min(names.length, indices.length);
      for (let i = 0; i < len; i++) {
        const value = snap.string(indices[i]);
        if (!omitEmpty || value !== '') out[names[i]!] = value;
      }
    }
    this.cachedStyles = Object.freeze(out);
    return this.cachedStyles;
  }

  /**
   * O(1) lookup for a single computed style property without decoding all style entries.
   * Returns `undefined` when the node has no layout entry, the property was not requested, or
   * `omitEmptyStyles: true` and the slot decoded to `''`.
   */
  style(propertyName: string): string | undefined {
    const idx = this.layoutIndex;
    if (idx === undefined) return undefined;
    const slot = this.document.snapshot.styleSlot(propertyName);
    if (slot === undefined) return undefined;
    const indices = this.document.raw.layout.styles?.[idx];
    if (!indices || slot >= indices.length) return undefined;
    const value = this.document.snapshot.string(indices[slot]);
    return this.document.snapshot.omitEmptyStyles && value === '' ? undefined : value;
  }
}

type RareStringField =
  | 'shadowRootType'
  | 'pseudoType'
  | 'pseudoIdentifier'
  | 'textValue'
  | 'inputValue'
  | 'currentSourceURL'
  | 'originURL';
type RareBooleanField = 'inputChecked' | 'optionSelected' | 'isClickable';

/** Lazy, zero-side-effect read-only view of one `DOMSnapshot.DocumentSnapshot`. */
export class DOMSnapshotDocumentView {
  readonly snapshot: DOMSnapshotView;
  readonly index: number;
  readonly raw: Protocol.DOMSnapshot.DocumentSnapshot;
  readonly nodeCount: number;
  private readonly nodeCache = new Map<number, DOMSnapshotNodeView>();
  private layoutFirst?: Map<number, number>;
  private layoutAll?: Map<number, number[]>;
  private stackingSet?: Set<number>;
  private backendMap?: Map<Protocol.DOM.BackendNodeId, number>;
  private childIndexMap?: Map<number, number[]>;
  private contentDocMap?: Map<number, number>;
  private readonly rareStrings = new Map<RareStringField, Map<number, number>>();
  private readonly rareBooleans = new Map<RareBooleanField, Set<number>>();

  /** @internal */
  constructor(
    snapshot: DOMSnapshotView,
    index: number,
    raw: Protocol.DOMSnapshot.DocumentSnapshot,
  ) {
    this.snapshot = snapshot;
    this.index = index;
    this.raw = raw;
    const n = raw.nodes;
    this.nodeCount = Math.max(
      n.nodeType?.length ?? 0,
      n.nodeName?.length ?? 0,
      n.backendNodeId?.length ?? 0,
      n.parentIndex?.length ?? 0,
    );
  }

  get documentURL(): string {
    return this.snapshot.string(this.raw.documentURL);
  }
  get title(): string {
    return this.snapshot.string(this.raw.title);
  }
  get baseURL(): string {
    return this.snapshot.string(this.raw.baseURL);
  }
  get contentLanguage(): string {
    return this.snapshot.string(this.raw.contentLanguage);
  }
  get encodingName(): string {
    return this.snapshot.string(this.raw.encodingName);
  }
  get publicId(): string {
    return this.snapshot.string(this.raw.publicId);
  }
  get systemId(): string {
    return this.snapshot.string(this.raw.systemId);
  }
  get frameId(): string {
    return this.snapshot.string(this.raw.frameId);
  }
  get scrollOffsetX(): number {
    return this.raw.scrollOffsetX ?? 0;
  }
  get scrollOffsetY(): number {
    return this.raw.scrollOffsetY ?? 0;
  }
  get contentWidth(): number | undefined {
    return this.raw.contentWidth;
  }
  get contentHeight(): number | undefined {
    return this.raw.contentHeight;
  }

  node(nodeIndex: number): DOMSnapshotNodeView | undefined {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= this.nodeCount)
      return undefined;
    let view = this.nodeCache.get(nodeIndex);
    if (!view) {
      view = new DOMSnapshotNodeView(this, nodeIndex);
      this.nodeCache.set(nodeIndex, view);
    }
    return view;
  }

  *nodes(): IterableIterator<DOMSnapshotNodeView> {
    for (let i = 0; i < this.nodeCount; i++) yield this.node(i)!;
  }

  nodeByBackendId(backendNodeId: Protocol.DOM.BackendNodeId): DOMSnapshotNodeView | undefined {
    if (!this.backendMap) {
      this.backendMap = new Map();
      const ids = this.raw.nodes.backendNodeId ?? [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (id !== undefined && id > 0 && !this.backendMap.has(id)) this.backendMap.set(id, i);
      }
    }
    const idx = this.backendMap.get(backendNodeId);
    return idx !== undefined ? this.node(idx) : undefined;
  }

  childrenOf(nodeIndex: number): readonly number[] {
    if (!this.childIndexMap) {
      this.childIndexMap = new Map();
      const parents = this.raw.nodes.parentIndex ?? [];
      for (let i = 0; i < parents.length; i++) {
        const p = parents[i];
        if (p === undefined || p < 0) continue;
        let list = this.childIndexMap.get(p);
        if (!list) {
          list = [];
          this.childIndexMap.set(p, list);
        }
        list.push(i);
      }
    }
    return this.childIndexMap.get(nodeIndex) ?? EMPTY_NUMBERS;
  }

  /** @internal */
  rareString(field: RareStringField, nodeIndex: number): string | undefined {
    let map = this.rareStrings.get(field);
    if (!map) {
      map = indexRare(this.raw.nodes[field]);
      this.rareStrings.set(field, map);
    }
    const strIdx = map.get(nodeIndex);
    return strIdx !== undefined && strIdx >= 0 ? this.snapshot.string(strIdx) : undefined;
  }

  /** @internal */
  rareBoolean(field: RareBooleanField, nodeIndex: number): boolean {
    let set = this.rareBooleans.get(field);
    if (!set) {
      set = indexRareBoolean(this.raw.nodes[field]);
      this.rareBooleans.set(field, set);
    }
    return set.has(nodeIndex);
  }

  /** @internal */
  contentDocumentIndexOf(nodeIndex: number): number | undefined {
    if (!this.contentDocMap) this.contentDocMap = indexRare(this.raw.nodes.contentDocumentIndex);
    return this.contentDocMap.get(nodeIndex);
  }

  private ensureLayoutIndex(): void {
    if (this.layoutFirst) return;
    this.layoutFirst = new Map();
    this.layoutAll = new Map();
    const indices = this.raw.layout.nodeIndex ?? [];
    for (let layoutIdx = 0; layoutIdx < indices.length; layoutIdx++) {
      const nodeIdx = indices[layoutIdx]!;
      if (!this.layoutFirst.has(nodeIdx)) this.layoutFirst.set(nodeIdx, layoutIdx);
      let list = this.layoutAll.get(nodeIdx);
      if (!list) {
        list = [];
        this.layoutAll.set(nodeIdx, list);
      }
      list.push(layoutIdx);
    }
  }

  /** @internal */
  layoutIndexOf(nodeIndex: number): number | undefined {
    this.ensureLayoutIndex();
    return this.layoutFirst!.get(nodeIndex);
  }

  /** @internal */
  layoutIndexesOf(nodeIndex: number): readonly number[] {
    this.ensureLayoutIndex();
    return this.layoutAll!.get(nodeIndex) ?? EMPTY_NUMBERS;
  }

  /** @internal */
  isStackingContextLayout(layoutIndex: number): boolean {
    if (!this.stackingSet) this.stackingSet = indexRareBoolean(this.raw.layout.stackingContexts);
    return this.stackingSet.has(layoutIndex);
  }
}

const EMPTY_NUMBERS: readonly number[] = Object.freeze([]);

/** Lazy, zero-side-effect read-only view over `DOMSnapshot.captureSnapshot` output. */
export class DOMSnapshotView {
  readonly raw: Protocol.DOMSnapshot.CaptureSnapshotResponse;
  readonly strings: readonly string[];
  readonly computedStyles: readonly string[];
  /** Uniform (or horizontal) scale divisor; see `cssScaleX` and `cssScaleY` for per-axis scales. */
  readonly cssScale: number;
  readonly cssScaleX: number;
  readonly cssScaleY: number;
  readonly omitEmptyStyles: boolean;
  readonly documents: readonly DOMSnapshotDocumentView[];
  private readonly styleSlots: Map<string, number>;
  private frameDocMap?: Map<string, DOMSnapshotDocumentView>;
  private backendDocMap?: Map<
    Protocol.DOM.BackendNodeId,
    { doc: DOMSnapshotDocumentView; nodeIndex: number }
  >;

  /** @internal */
  constructor(
    raw: Protocol.DOMSnapshot.CaptureSnapshotResponse,
    options: ParseDOMSnapshotOptions = {},
  ) {
    const rawScale = options.cssScale ?? 1;
    let cssScaleX: number;
    let cssScaleY: number;
    if (typeof rawScale === 'number') {
      if (!Number.isFinite(rawScale) || rawScale <= 0)
        throw new RangeError('cssScale must be a positive finite number');
      cssScaleX = rawScale;
      cssScaleY = rawScale;
    } else if (rawScale && typeof rawScale === 'object') {
      cssScaleX = rawScale.x;
      cssScaleY = rawScale.y;
      if (
        typeof cssScaleX !== 'number' ||
        typeof cssScaleY !== 'number' ||
        !Number.isFinite(cssScaleX) ||
        !Number.isFinite(cssScaleY) ||
        cssScaleX <= 0 ||
        cssScaleY <= 0
      )
        throw new RangeError(
          'cssScale must be a positive finite number or { x, y } with positive finite numbers',
        );
    } else {
      throw new RangeError(
        'cssScale must be a positive finite number or { x, y } with positive finite numbers',
      );
    }
    this.raw = raw;
    this.strings = raw.strings ?? [];
    this.computedStyles = [...(options.computedStyles ?? [])];
    this.cssScale = cssScaleX;
    this.cssScaleX = cssScaleX;
    this.cssScaleY = cssScaleY;
    this.omitEmptyStyles = options.omitEmptyStyles ?? false;
    this.styleSlots = new Map();
    for (let i = 0; i < this.computedStyles.length; i++)
      if (!this.styleSlots.has(this.computedStyles[i]!))
        this.styleSlots.set(this.computedStyles[i]!, i);
    this.documents = (raw.documents ?? []).map(
      (doc, idx) => new DOMSnapshotDocumentView(this, idx, doc),
    );
  }

  get rootDocument(): DOMSnapshotDocumentView | undefined {
    return this.documents[0];
  }

  /** Decodes a CDP `StringIndex` against the shared string table (`''` for missing or `-1`). */
  string(index: number | undefined): string {
    if (index === undefined || index < 0 || index >= this.strings.length) return '';
    return this.strings[index] ?? '';
  }

  /** @internal */
  styleSlot(propertyName: string): number | undefined {
    return this.styleSlots.get(propertyName);
  }

  documentByFrameId(frameId: string): DOMSnapshotDocumentView | undefined {
    if (!this.frameDocMap) {
      this.frameDocMap = new Map();
      for (const doc of this.documents)
        if (doc.frameId && !this.frameDocMap.has(doc.frameId))
          this.frameDocMap.set(doc.frameId, doc);
    }
    return this.frameDocMap.get(frameId);
  }

  findNodeByBackendId(backendNodeId: Protocol.DOM.BackendNodeId): DOMSnapshotNodeView | undefined {
    if (!this.backendDocMap) {
      this.backendDocMap = new Map();
      for (const doc of this.documents) {
        const ids = doc.raw.nodes.backendNodeId ?? [];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          if (id !== undefined && id > 0 && !this.backendDocMap.has(id))
            this.backendDocMap.set(id, { doc, nodeIndex: i });
        }
      }
    }
    const hit = this.backendDocMap.get(backendNodeId);
    return hit ? hit.doc.node(hit.nodeIndex) : undefined;
  }
}

/**
 * Wraps a raw `DOMSnapshot.captureSnapshot` response in a lazy, typed read-only view.
 * Performs no CDP calls and never enables any protocol domain.
 */
export function parseDOMSnapshot(
  raw: Protocol.DOMSnapshot.CaptureSnapshotResponse,
  options: ParseDOMSnapshotOptions = {},
): DOMSnapshotView {
  return new DOMSnapshotView(raw, options);
}
