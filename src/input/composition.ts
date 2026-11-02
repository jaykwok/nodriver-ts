import { randomUUID } from 'node:crypto';
import type { Protocol } from 'devtools-protocol';
import { TargetSession, type Session } from '../protocol/connection.ts';
import { ActionabilityError, ProtocolError } from '../errors.ts';
import { isContextGone } from '../page/execution-context.ts';
import type { InputAction, InputRelease } from './action.ts';
import type { InputOptions } from './behavior.ts';
export interface CompositionSelection {
  selectionStart?: number;
  selectionEnd?: number;
}
export interface CompositionOptions {
  /**
   * Cancel at the session's current focus even if the original editor or document changed.
   * Applies to explicit cancel and automatic cleanup, never to updates or commits. Defaults
   * to false. An empty IME command can cancel a composition in the newly focused editor; it is
   * sent there only when that editor has a collapsed selection, because without a composition
   * Chrome deletes the selected text instead.
   */
  forceCancel?: boolean;
  /**
   * Execution context for focus probes, such as your own isolated world. By default the probes
   * run in an isolated world the library creates; never in the page's main world.
   */
  executionContextId?: number;
}
// Descends open shadow roots and same-origin frames from `el` to the focused element.
const DESCEND =
  'while(el){let next=el.shadowRoot?.activeElement;try{next ||= el.contentDocument?.activeElement}catch{}if(!next)break;el=next}';
const FOCUSED = `function(){let el=document.activeElement;${DESCEND}return el}`;
// Continues inside a closed shadow root. Passing the host also proves that the root was resolved
// into the same world: V8 rejects an argument from another world before running the function.
const FOCUSED_IN_ROOT = `function(host){if(this.host!==host)return'mismatch';let el=this.activeElement;${DESCEND}return el}`;
// Text inputs and textareas that are neither read-only nor disabled (including by a fieldset) are
// editable, as is content of contenteditable elements and designMode documents. Focus on a frame element is in
// a cross-origin document that the probe cannot inspect. `host` marks elements that can have a
// shadow root.
const CLASSIFY =
  "function(){const el=this,html=el.namespaceURI==='http://www.w3.org/1999/xhtml',name=el.localName,host=html&&(name.includes('-')||['article','aside','blockquote','body','div','footer','h1','h2','h3','h4','h5','h6','header','main','nav','p','section','span'].includes(name));let kind='none';if(html&&name==='input')kind=['text','search','url','tel','email','password','number'].includes(el.type)&&el.matches(':read-write')?'editable':'none';else if(html&&name==='textarea')kind=el.matches(':read-write')?'editable':'none';else if(el.isContentEditable)kind='content';else if(html&&['iframe','frame','object','embed'].includes(name))kind='unknown';return{kind,host}}";
// The editing host of editable content. Chrome moves focus from a focusable descendant to its
// editing host when composition starts; a designMode document's host is its root element.
const EDITING_HOST =
  'function(){let el=this;while(el.parentElement?.isContentEditable)el=el.parentElement;return el}';
// Whether an empty IME update at this editor cannot delete text: Chrome deletes the selection when
// no composition exists, so only a collapsed (or absent) selection is safe.
const COLLAPSED =
  "function(){if(this.localName==='input'||this.localName==='textarea')return this.selectionStart!==null&&this.selectionStart===this.selectionEnd;const sel=this.getRootNode().getSelection?.();return !!sel&&(sel.rangeCount===0||sel.isCollapsed)}";
// Tracks in the probe world whether the composition is over, for example because Chrome finished it
// when focus left. A new composition starts over.
const WATCH_END =
  "function(){const state={ended:false,listener:(event)=>{state.ended=event.type==='compositionend'}};this.addEventListener('compositionstart',state.listener,true);this.addEventListener('compositionend',state.listener,true);return state}";
const UNWATCH_END =
  "function(state){this.removeEventListener('compositionstart',state.listener,true);this.removeEventListener('compositionend',state.listener,true)}";
/** Closed shadow roots followed at most while resolving the focused element. */
const MAX_CLOSED_ROOTS = 32;
/**
 * One probe world per session, reused through a handle to its global object while its document
 * lives. Unlike a numeric context ID, which a new renderer process can reuse after navigation,
 * a remote object ID never resolves into another context.
 */
const worlds = new WeakMap<Session, { objectId: string; contextId: number }>();
const WORLD_GROUP = 'nodriver-composition-world';
type Kind = 'editable' | 'content' | 'none' | 'unknown';
type Send = InputAction['send'];
function isStale(error: unknown): boolean {
  return (
    isContextGone(error) ||
    (error instanceof ProtocolError &&
      /Could not find object with given id|Argument should belong to the same JavaScript world/.test(
        error.message,
      ))
  );
}
/** One explicit composition, with at most one commit attempt. Created by compose() or a scope. */
export class Composition {
  private state: 'idle' | 'composing' | 'committing' | 'committed' | 'cancelled' = 'idle';
  private text = '';
  private focus?: string;
  private group?: string;
  /** Probe state of the composition's end; absent where its events cannot be observed. */
  private endWatch?: string;
  /** The global object of the explicit execution context, resolved once. */
  private global?: string;
  private release?: InputRelease;
  readonly session: Session;
  private readonly action: InputAction;
  private readonly options: CompositionOptions;
  constructor(session: Session, action: InputAction, options: CompositionOptions = {}) {
    this.session = session;
    this.action = action;
    this.options = options;
  }
  private async captureFocus(): Promise<void> {
    const group = (this.group = 'nodriver-composition-' + randomUUID());
    this.action.release(() => this.action.releaseObjects(this.session, { objectGroup: group }));
    try {
      const { element, kind } = await this.resolveFocus(group, this.action.send.bind(this.action));
      if (!element) throw new ActionabilityError('Composition requires a focused element');
      if (kind === 'none')
        throw new ActionabilityError('Composition requires an editable focused element');
      if (kind === 'unknown') this.action.note('compositionFocusUnknown');
      this.focus = element;
      // The composition events of a cross-origin frame do not reach its frame element.
      if (kind !== 'unknown') await this.watchEnd(element, group);
    } catch (error) {
      // Timeouts and disconnects stop the action as they are; only a replaced document is mapped.
      if (!isStale(error)) throw error;
      throw new ActionabilityError('Composition target lost focus or its document changed', {
        cause: error,
      });
    }
  }
  private async watchEnd(element: string, group: string): Promise<void> {
    const { result, exceptionDetails } = await this.action.send(
      this.session,
      'Runtime.callFunctionOn',
      { objectId: element, functionDeclaration: WATCH_END, objectGroup: group },
    );
    if (exceptionDetails || !result.objectId) return;
    const state = (this.endWatch = result.objectId);
    this.action.release(async () => {
      await this.action
        .sendCleanup(this.session, 'Runtime.callFunctionOn', {
          objectId: element,
          functionDeclaration: UNWATCH_END,
          arguments: [{ objectId: state }],
        })
        .catch(() => {});
    });
  }
  /**
   * Resolves the focused element, following closed shadow roots, and classifies whether it can
   * take text; contenteditable content resolves to its editing host. Focus in a cross-origin frame
   * cannot be inspected: its editability is unknown, and focus changes inside that frame are not
   * detected.
   */
  private async resolveFocus(group: string, send: Send): Promise<{ element?: string; kind: Kind }> {
    const { object, contextId } = await this.focused(group, send);
    if (!object.objectId) return { kind: 'none' };
    let element: string = object.objectId;
    for (let roots = 0; ; roots++) {
      const { result, exceptionDetails } = await send(this.session, 'Runtime.callFunctionOn', {
        objectId: element,
        functionDeclaration: CLASSIFY,
        returnByValue: true,
      });
      if (exceptionDetails) throw new ActionabilityError('Composition focus probe failed');
      const { kind, host } = result.value as { kind: Kind; host: boolean };
      const inner: string | undefined = host
        ? await this.closedRootFocus(element, contextId, group, send)
        : undefined;
      if (inner) {
        if (roots >= MAX_CLOSED_ROOTS)
          throw new ActionabilityError(
            'Composition focus is nested in too many closed shadow roots',
          );
        element = inner;
        continue;
      }
      if (kind !== 'content') return { element, kind };
      const { result: editor, exceptionDetails: failed } = await send(
        this.session,
        'Runtime.callFunctionOn',
        { objectId: element, functionDeclaration: EDITING_HOST, objectGroup: group },
      );
      if (failed || !editor.objectId)
        throw new ActionabilityError('Composition focus probe failed');
      return { element: editor.objectId, kind };
    }
  }
  /** The element focused inside the host's closed shadow root, if the focus is there. */
  private async closedRootFocus(
    host: string,
    contextId: number,
    group: string,
    send: Send,
  ): Promise<string | undefined> {
    // Neither DOM.describeNode nor DOM.resolveNode enables the DOM domain.
    const { node } = await send(this.session, 'DOM.describeNode', {
      objectId: host,
      depth: 0,
      pierce: true,
    });
    const root = node.shadowRoots?.find((shadow) => shadow.shadowRootType === 'closed');
    if (!root) return undefined;
    const { object } = await send(this.session, 'DOM.resolveNode', {
      backendNodeId: root.backendNodeId,
      executionContextId: contextId,
      objectGroup: group,
    });
    if (!object.objectId) throw new ActionabilityError('Composition focus probe failed');
    const { result, exceptionDetails } = await send(this.session, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: FOCUSED_IN_ROOT,
      arguments: [{ objectId: host }],
      objectGroup: group,
    });
    if (exceptionDetails) throw new ActionabilityError('Composition focus probe failed');
    if (result.value === 'mismatch')
      throw new ActionabilityError('Composition target lost focus or its document changed');
    // No object: the host itself has focus.
    return result.objectId;
  }
  private async focused(
    group: string,
    send: Send,
  ): Promise<{ object: Protocol.Runtime.RemoteObject; contextId: number }> {
    const probe = async (target: { objectId: string }): Promise<Protocol.Runtime.RemoteObject> => {
      const { result, exceptionDetails } = await send(this.session, 'Runtime.callFunctionOn', {
        ...target,
        functionDeclaration: FOCUSED,
        objectGroup: group,
      });
      if (exceptionDetails) throw new ActionabilityError('Composition focus probe failed');
      return result;
    };
    const explicit = this.options.executionContextId;
    if (explicit !== undefined) {
      try {
        // Later probes use a handle: a numeric ID can name a newer context after navigation.
        if (!this.global) {
          const { result } = await send(this.session, 'Runtime.evaluate', {
            expression: 'globalThis',
            contextId: explicit,
            objectGroup: group,
          });
          if (!result.objectId)
            throw new ActionabilityError('Composition execution context is unavailable');
          this.global = result.objectId;
        }
        return { object: await probe({ objectId: this.global }), contextId: explicit };
      } catch (error) {
        if (!isStale(error)) throw error;
        throw new ActionabilityError('Composition execution context is gone', { cause: error });
      }
    }
    const cached = worlds.get(this.session);
    if (cached) {
      try {
        return { object: await probe({ objectId: cached.objectId }), contextId: cached.contextId };
      } catch (error) {
        if (!isStale(error)) throw error;
        if (worlds.get(this.session) === cached) worlds.delete(this.session);
      }
    }
    // Page.getFrameTree and Page.createIsolatedWorld work without Page.enable.
    const frameId =
      this.session instanceof TargetSession
        ? this.session.targetId
        : (await send(this.session, 'Page.getFrameTree')).frameTree.frame.id;
    const { executionContextId } = await send(this.session, 'Page.createIsolatedWorld', {
      frameId,
    });
    const { result: world } = await send(this.session, 'Runtime.evaluate', {
      expression: 'globalThis',
      contextId: executionContextId,
      objectGroup: WORLD_GROUP,
    });
    if (!world.objectId) throw new ActionabilityError('Composition probe world is unavailable');
    worlds.set(this.session, { objectId: world.objectId, contextId: executionContextId });
    return { object: await probe({ objectId: world.objectId }), contextId: executionContextId };
  }
  /**
   * Checks that the element still has focus, through each shadow root and frame the probe can
   * reach. A frame whose parent it cannot reach, such as a cross-origin or out-of-process frame,
   * must have focus itself.
   */
  private async checkFocus(cleanup = false): Promise<void> {
    if (!this.focus) throw new ActionabilityError('Composition has no focused element');
    const send = cleanup
      ? this.action.sendCleanup.bind(this.action)
      : this.action.send.bind(this.action);
    let response: Protocol.Runtime.CallFunctionOnResponse;
    try {
      response = await send(this.session, 'Runtime.callFunctionOn', {
        objectId: this.focus,
        returnByValue: true,
        functionDeclaration:
          'function(){if(!this.isConnected)return false;let el=this,editor=this.isContentEditable;while(el){const root=el.getRootNode(),active=root.activeElement;if(active!==el&&!(editor&&el.contains(active)&&active.isContentEditable))return false;editor=false;if(root.host){el=root.host;continue}const view=root.defaultView;if(!view)return false;try{el=view.frameElement}catch{el=null}if(!el&&view!==view.top)return root.hasFocus()}return true}',
      });
    } catch (error) {
      // The probe world ends with its document.
      if (!isStale(error)) throw error;
      throw new ActionabilityError('Composition target lost focus or its document changed', {
        cause: error,
      });
    }
    if (response.exceptionDetails || response.result.value !== true)
      throw new ActionabilityError('Composition target lost focus or its document changed');
  }
  /** Whether the composition is known to be over, so that an empty IME update would hit none. */
  private async ended(): Promise<boolean> {
    if (!this.endWatch) return false;
    try {
      const { result, exceptionDetails } = await this.action.sendCleanup(
        this.session,
        'Runtime.callFunctionOn',
        {
          objectId: this.endWatch,
          functionDeclaration: 'function(){return this.ended}',
          returnByValue: true,
        },
      );
      return !!exceptionDetails || result.value === true;
    } catch (error) {
      if (!isStale(error)) throw error;
      throw new ActionabilityError('Composition target lost focus or its document changed', {
        cause: error,
      });
    }
  }
  /**
   * Allows a cancel. The original editor needs no further check while its composition lasts.
   * Otherwise the empty IME update may hit no composition: Chrome then deletes the selection at the
   * current focus, so the cancel needs an inspectable editor with a collapsed selection. Without
   * forceCancel, focus must not have moved.
   */
  private async checkCancel(): Promise<void> {
    try {
      await this.checkFocus(true);
      if (!(await this.ended())) return;
    } catch (error) {
      if (!(error instanceof ActionabilityError) || !this.options.forceCancel) throw error;
    }
    const send = this.action.sendCleanup.bind(this.action) as Send;
    let collapsed = false;
    try {
      const { element, kind } = await this.resolveFocus(this.group!, send);
      if (element && (kind === 'editable' || kind === 'content')) {
        const { result, exceptionDetails } = await send(this.session, 'Runtime.callFunctionOn', {
          objectId: element,
          functionDeclaration: COLLAPSED,
          returnByValue: true,
        });
        collapsed = !exceptionDetails && result.value === true;
      }
    } catch (error) {
      if (!isStale(error) && !(error instanceof ActionabilityError)) throw error;
    }
    if (!collapsed)
      throw new ActionabilityError(
        'Composition cancel refused: the current focus is not an inspectable editor with a collapsed selection',
      );
  }
  async update(
    text: string,
    selection: CompositionSelection = {},
    options: InputOptions = {},
  ): Promise<void> {
    await this.action.perform(options, async (action) => {
      if (this.state !== 'idle' && this.state !== 'composing')
        throw new Error('Composition already ended');
      if (!text.length || text.length > 100000)
        throw new RangeError('Composition text must contain 1–100000 UTF-16 units');
      const selectionStart = selection.selectionStart ?? text.length;
      const selectionEnd = selection.selectionEnd ?? selectionStart;
      if (
        !Number.isInteger(selectionStart) ||
        !Number.isInteger(selectionEnd) ||
        selectionStart < 0 ||
        selectionEnd < selectionStart ||
        selectionEnd > text.length
      )
        throw new RangeError('Composition selection must be UTF-16 offsets within the text');
      if (this.state === 'idle') await this.captureFocus();
      await action.check();
      await this.checkFocus();
      await action.check();
      if (this.state === 'idle') {
        this.release = action.release(
          async () => {
            await this.checkCancel();
            await action.sendCleanup(this.session, 'Input.imeSetComposition', {
              text: '',
              selectionStart: 0,
              selectionEnd: 0,
            });
            this.state = 'cancelled';
            action.record('compositionCancel');
          },
          { session: this.session, composition: true },
        );
      }
      this.state = 'composing';
      this.text = text;
      await action.send(this.session, 'Input.imeSetComposition', {
        text,
        selectionStart,
        selectionEnd,
      });
      action.record('compositionUpdate');
    });
  }
  async commit(text?: string, options: InputOptions = {}): Promise<void> {
    await this.action.perform(options, async (action) => {
      if (this.state !== 'composing')
        throw new Error('Composition is not active or already committed');
      const value = text ?? this.text;
      if (!value.length || value.length > 100000)
        throw new RangeError('Composition commit must contain 1–100000 UTF-16 units');
      await this.checkFocus();
      await action.check();
      this.state = 'committing';
      await action.send(this.session, 'Input.insertText', { text: value });
      this.state = 'committed';
      this.release!.forget();
      action.report.completedSegments++;
      action.record('compositionCommit');
    });
  }
  async cancel(options: InputOptions = {}): Promise<void> {
    await this.action.perform(options, async () => {
      if (this.state === 'committed' || this.state === 'committing')
        throw new Error('Composition commit was already attempted');
      if (this.state === 'idle') this.state = 'cancelled';
      else if (this.state !== 'cancelled') await this.release!.run();
    });
  }
}
