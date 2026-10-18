import { spyOn } from 'bun:test';
import { WebSocketTransport } from '../../src/transport/websocket.js';
import { PipeTransport } from '../../src/transport/pipe.js';

export const forbiddenAutomaticCommands = [
  'Runtime.enable',
  'Runtime.disable',
  'Runtime.addBinding',
  'Console.enable',
  'Debugger.enable',
  'Page.addScriptToEvaluateOnNewDocument',
];

export function recordWire(transport: 'websocket' | 'pipe') {
  const prototype =
    transport === 'websocket' ? WebSocketTransport.prototype : PipeTransport.prototype;
  const original = prototype.send;
  const messages: Array<{ method: string; sessionId?: string; params?: Record<string, unknown> }> =
    [];
  const spy = spyOn(prototype, 'send').mockImplementation(function (this: never, message: string) {
    messages.push(JSON.parse(message));
    return original.call(this, message);
  });
  return { messages, restore: () => spy.mockRestore() };
}
