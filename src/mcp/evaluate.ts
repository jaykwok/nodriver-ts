import type { Frame, World } from '../page/frames.ts';
import { EvaluationError } from '../errors.ts';
import type { WaitOptions } from '../utils.ts';

export const MAX_SCRIPT_LENGTH = 32_768;
export const MAX_ARGUMENT_LENGTH = 32_768;
export const MAX_RESULT_LENGTH = 262_144;

/** Script compilation and execution occur in Chrome, never in the MCP host. */
export async function evaluateScript(
  frame: Frame,
  script: string,
  arg: unknown,
  options: WaitOptions & { world: World; timeout: number },
): Promise<Record<string, unknown>> {
  // Encode twice: a JS string containing JSON, not an object literal. This also
  // preserves own __proto__ keys and keeps argument text separate from code.
  const argument = JSON.stringify(JSON.stringify(arg));
  const expression = `(async () => {
    const value = await (async (arg) => {
      ${script}
    })(JSON.parse(${argument}));
    if (value === undefined) return { type: 'undefined' };
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('Return a JSON-serializable value or undefined');
    if (json.length > ${MAX_RESULT_LENGTH}) throw new RangeError('Script result exceeds ${MAX_RESULT_LENGTH} JSON characters; return a smaller projection');
    return { type: 'json', json };
  })()`;
  try {
    const packet = await frame.evaluate<unknown>(expression, undefined, {
      ...options,
      executionTimeout: options.timeout,
    });
    // Main-world builtins may be modified by the page. Check the envelope again
    // on the host; this bounds returned data, not arbitrary page memory usage.
    if (!packet || typeof packet !== 'object') throw new EvaluationError('Invalid script result');
    if ('type' in packet && packet.type === 'undefined') return { type: 'undefined' };
    if (
      !('type' in packet) ||
      packet.type !== 'json' ||
      !('json' in packet) ||
      typeof packet.json !== 'string' ||
      packet.json.length > MAX_RESULT_LENGTH
    )
      throw new EvaluationError('Invalid or oversized script result');
    return { type: 'json', value: JSON.parse(packet.json) as unknown };
  } catch (error) {
    if (error instanceof EvaluationError) throw new EvaluationError(error.message.slice(0, 4000));
    throw error;
  }
}
