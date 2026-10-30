import { randomUUID } from 'node:crypto';
import type { Session } from '../protocol/connection.ts';
import { ActionabilityError } from '../errors.ts';
import type { InputAction, InputRelease } from './action.ts';
import type { InputOptions } from './behavior.ts';
export interface CompositionSelection {
  selectionStart?: number;
  selectionEnd?: number;
}
/** One explicit composition, with at most one commit attempt. Created by compose() or a scope. */
export class Composition {
  private state: 'idle' | 'composing' | 'committing' | 'committed' | 'cancelled' = 'idle';
  private text = '';
  private focus?: string;
  private release?: InputRelease;
  readonly session: Session;
  private readonly action: InputAction;
  constructor(session: Session, action: InputAction) {
    this.session = session;
    this.action = action;
  }
  private async captureFocus(): Promise<void> {
    const group = 'nodriver-composition-' + randomUUID();
    this.action.release(async () => {
      await this.action.sendCleanup(this.session, 'Runtime.releaseObjectGroup', {
        objectGroup: group,
      });
    });
    const { root } = await this.action.send(this.session, 'DOM.getDocument', { depth: 0 });
    const { object } = await this.action.send(this.session, 'DOM.resolveNode', {
      nodeId: root.nodeId,
      objectGroup: group,
    });
    const { result, exceptionDetails } = await this.action.send(
      this.session,
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId!,
        objectGroup: group,
        functionDeclaration:
          'function(){let el=this.activeElement;while(el){let next=el.shadowRoot?.activeElement;try{next ||= el.contentDocument?.activeElement}catch{}if(!next)break;el=next}return el}',
      },
    );
    if (exceptionDetails || !result.objectId)
      throw new ActionabilityError('Composition requires a focused element');
    this.focus = result.objectId;
  }
  private async checkFocus(cleanup = false): Promise<void> {
    if (!this.focus) throw new ActionabilityError('Composition has no focused element');
    const send = cleanup
      ? this.action.sendCleanup.bind(this.action)
      : this.action.send.bind(this.action);
    const { result, exceptionDetails } = await send(this.session, 'Runtime.callFunctionOn', {
      objectId: this.focus,
      returnByValue: true,
      functionDeclaration:
        'function(){if(!this.isConnected)return false;let el=this;while(el){const root=el.getRootNode();if(root.activeElement!==el)return false;if(root.host){el=root.host;continue}const view=root.defaultView;if(!view)return false;try{el=view.frameElement;if(!el&&view!==view.top)return false}catch{return false}}return true}',
    });
    if (exceptionDetails || result.value !== true)
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
        });
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
