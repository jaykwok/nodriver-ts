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
/** Closed shadow roots followed at most while resolving the focused element. */
const MAX_CLOSED_ROOTS = 32;
/**
 * One probe world per session, reused through a handle to its global object while its document
 * lives. Unlike a numeric context ID, which a new renderer process can reuse after navigation,
 * a remote object ID never resolves into another context.
 */
const worlds = new WeakMap<Session, { objectId: string; contextId: number }>();
const WORLD_GROUP = 'nodriver-composition-world';
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
    const group = 'nodriver-composition-' + randomUUID();
    this.action.release(async () => {
      await this.action.sendCleanup(this.session, 'Runtime.releaseObjectGroup', {
        objectGroup: group,
      });
    });
    try {
      this.focus = await this.editableFocus(group);
    } catch (error) {
      // Timeouts and disconnects stop the action as they are; only a replaced document is mapped.
      if (!isStale(error)) throw error;
      throw new ActionabilityError('Composition target lost focus or its document changed', {
        cause: error,
      });
    }
  }
  /**
   * Resolves the focused element, following closed shadow roots, and fails before any
   * composition command when it cannot take text. Focus in a cross-origin frame cannot be
   * inspected: its editability is unknown and composition proceeds, but focus changes inside that
   * frame are not detected.
   */
  private async editableFocus(group: string): Promise<string> {
    const { object, contextId } = await this.focused(group);
    if (!object.objectId) throw new ActionabilityError('Composition requires a focused element');
    let element: string = object.objectId;
    for (let roots = 0; ; roots++) {
      const { result, exceptionDetails } = await this.action.send(
        this.session,
        'Runtime.callFunctionOn',
        { objectId: element, functionDeclaration: CLASSIFY, returnByValue: true },
      );
      if (exceptionDetails) throw new ActionabilityError('Composition focus probe failed');
      const { kind, host } = result.value as {
        kind: 'editable' | 'content' | 'none' | 'unknown';
        host: boolean;
      };
      const inner: string | undefined = host
        ? await this.closedRootFocus(element, contextId, group)
        : undefined;
      if (inner) {
        if (roots >= MAX_CLOSED_ROOTS)
          throw new ActionabilityError(
            'Composition focus is nested in too many closed shadow roots',
          );
        element = inner;
        continue;
      }
      if (kind === 'none')
        throw new ActionabilityError('Composition requires an editable focused element');
      if (kind === 'unknown') this.action.note('compositionFocusUnknown');
      if (kind !== 'content') return element;
      const { result: editor, exceptionDetails: failed } = await this.action.send(
        this.session,
        'Runtime.callFunctionOn',
        { objectId: element, functionDeclaration: EDITING_HOST, objectGroup: group },
      );
      if (failed || !editor.objectId)
        throw new ActionabilityError('Composition focus probe failed');
      return editor.objectId;
    }
  }
  /** The element focused inside the host's closed shadow root, if the focus is there. */
  private async closedRootFocus(
    host: string,
    contextId: number,
    group: string,
  ): Promise<string | undefined> {
    // Neither DOM.describeNode nor DOM.resolveNode enables the DOM domain.
    const { node } = await this.action.send(this.session, 'DOM.describeNode', {
      objectId: host,
      depth: 0,
      pierce: true,
    });
    const root = node.shadowRoots?.find((shadow) => shadow.shadowRootType === 'closed');
    if (!root) return undefined;
    const { object } = await this.action.send(this.session, 'DOM.resolveNode', {
      backendNodeId: root.backendNodeId,
      executionContextId: contextId,
      objectGroup: group,
    });
    if (!object.objectId) throw new ActionabilityError('Composition focus probe failed');
    const { result, exceptionDetails } = await this.action.send(
      this.session,
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: FOCUSED_IN_ROOT,
        arguments: [{ objectId: host }],
        objectGroup: group,
      },
    );
    if (exceptionDetails) throw new ActionabilityError('Composition focus probe failed');
    if (result.value === 'mismatch')
      throw new ActionabilityError('Composition target lost focus or its document changed');
    // No object: the host itself has focus.
    return result.objectId;
  }
  private async focused(
    group: string,
  ): Promise<{ object: Protocol.Runtime.RemoteObject; contextId: number }> {
    const probe = async (
      target: { objectId: string } | { executionContextId: number },
    ): Promise<Protocol.Runtime.RemoteObject> => {
      const { result, exceptionDetails } = await this.action.send(
        this.session,
        'Runtime.callFunctionOn',
        { ...target, functionDeclaration: FOCUSED, objectGroup: group },
      );
      if (exceptionDetails) throw new ActionabilityError('Composition focus probe failed');
      return result;
    };
    const explicit = this.options.executionContextId;
    if (explicit !== undefined) {
      const object = await probe({ executionContextId: explicit }).catch((error: unknown) => {
        if (!isStale(error)) throw error;
        throw new ActionabilityError('Composition execution context is gone', { cause: error });
      });
      return { object, contextId: explicit };
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
        : (await this.action.send(this.session, 'Page.getFrameTree')).frameTree.frame.id;
    const { executionContextId } = await this.action.send(
      this.session,
      'Page.createIsolatedWorld',
      { frameId },
    );
    const { result: world } = await this.action.send(this.session, 'Runtime.evaluate', {
      expression: 'globalThis',
      contextId: executionContextId,
      objectGroup: WORLD_GROUP,
    });
    if (!world.objectId) throw new ActionabilityError('Composition probe world is unavailable');
    worlds.set(this.session, { objectId: world.objectId, contextId: executionContextId });
    return { object: await probe({ objectId: world.objectId }), contextId: executionContextId };
  }
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
          'function(){if(!this.isConnected)return false;let el=this,editor=this.isContentEditable;while(el){const root=el.getRootNode(),active=root.activeElement;if(active!==el&&!(editor&&el.contains(active)&&active.isContentEditable))return false;editor=false;if(root.host){el=root.host;continue}const view=root.defaultView;if(!view)return false;try{el=view.frameElement;if(!el&&view!==view.top)return false}catch{return false}}return true}',
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
      if (this.state === 'idle') {
        await this.captureFocus();
        this.release = action.release(async () => {
          await this.checkFocus(true);
          await action.sendCleanup(this.session, 'Input.imeSetComposition', {
            text: '',
            selectionStart: 0,
            selectionEnd: 0,
          });
          this.state = 'cancelled';
          action.record('compositionCancel');
        }, this.session);
      }
      await action.check();
      await this.checkFocus();
      await action.check();
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
