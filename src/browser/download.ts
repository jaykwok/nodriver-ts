import { copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EventHub, type WaitOptions } from '../utils.ts';
import { NodriverError } from '../errors.ts';
import type { BrowserContext } from './context.ts';
export class Download {
  private state: 'inProgress' | 'completed' | 'canceled' = 'inProgress';
  /** Emits on every state report from the browser; read `status` for the new state. */
  readonly updates = new EventHub<void>();
  readonly context: BrowserContext;
  readonly guid: string;
  readonly url: string;
  readonly suggestedFilename: string;
  readonly directory: string;
  constructor(
    context: BrowserContext,
    guid: string,
    url: string,
    suggestedFilename: string,
    directory: string,
  ) {
    this.context = context;
    this.guid = guid;
    this.url = url;
    this.suggestedFilename = suggestedFilename;
    this.directory = directory;
  }
  get status(): 'inProgress' | 'completed' | 'canceled' {
    return this.state;
  }
  progress(state: 'inProgress' | 'completed' | 'canceled'): void {
    this.state = state;
    this.updates.emit();
  }
  async path(options: WaitOptions = {}): Promise<string> {
    if (this.state === 'inProgress')
      await this.context.browser.waitEvent(
        this.updates,
        () => this.state !== 'inProgress',
        options,
        'download completion',
      );
    if (this.state === 'canceled') throw new NodriverError(`Download canceled: ${this.guid}`);
    return join(this.directory, this.guid);
  }
  async saveAs(path: string, options: WaitOptions = {}): Promise<void> {
    await copyFile(await this.path(options), resolve(path));
  }
  async cancel(): Promise<void> {
    await this.context.browser.cdp.send('Browser.cancelDownload', {
      guid: this.guid,
      browserContextId: this.context.id,
    });
  }
}
