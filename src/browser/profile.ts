import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { NodriverError } from '../errors.ts';
export type ProfileSettings = { [key: string]: unknown };
export interface ProfileSettingsUpdate {
  /** Merged into `<directory>/Local State`, which holds browser-wide settings. */
  localState?: ProfileSettings;
  /** Merged into `<directory>/<profile>/Preferences`. */
  preferences?: ProfileSettings;
  /** Profile subdirectory of `preferences`. Defaults to `Default`. */
  profile?: string;
}
function isObject(value: unknown): value is ProfileSettings {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function merge(target: ProfileSettings, patch: ProfileSettings): ProfileSettings {
  const result = { ...target };
  for (const [key, value] of Object.entries(patch))
    result[key] =
      isObject(value) && isObject(result[key])
        ? merge(result[key] as ProfileSettings, value)
        : structuredClone(value);
  return result;
}
/** Dotted paths of the patch's leaves that the file does not hold. */
function differences(file: unknown, patch: ProfileSettings, prefix = ''): string[] {
  return Object.entries(patch).flatMap(([key, value]) => {
    const actual = isObject(file) ? file[key] : undefined;
    return isObject(value)
      ? differences(actual, value, `${prefix}${key}.`)
      : isDeepStrictEqual(actual, value)
        ? []
        : [`${prefix}${key}`];
  });
}
async function readSettings(path: string): Promise<ProfileSettings> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Never replace a file Chrome could still recover from with our partial view of it.
    throw new NodriverError(`${path} is not valid JSON; refusing to rewrite it`, { cause: error });
  }
  if (!isObject(parsed)) throw new NodriverError(`${path} does not hold a JSON object`);
  return parsed;
}
async function updateFile(path: string, patch: ProfileSettings): Promise<void> {
  const next = merge(await readSettings(path), patch);
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.nodriver-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(next));
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  const missing = differences(await readSettings(path), patch);
  if (missing.length)
    throw new NodriverError(`${path} did not keep ${missing.join(', ')} after writing`);
}
/**
 * Merges settings into a profile's `Local State` and `Preferences` and reads each file back to
 * check that every given value is there. Objects merge key by key; other values, arrays included,
 * replace what the file holds, and other keys are kept. Use it only while no browser runs with the
 * profile, for example from the `prepareProfile` launch option. The check covers the files, not
 * whether a browser version reads or honours a setting.
 */
export async function updateProfileSettings(
  directory: string,
  update: ProfileSettingsUpdate,
): Promise<void> {
  const profile = update.profile ?? 'Default';
  if (!profile || /[\\/]|^\.\.?$/.test(profile))
    throw new TypeError('profile must be a single directory name');
  if (update.localState) await updateFile(join(directory, 'Local State'), update.localState);
  if (update.preferences)
    await updateFile(join(directory, profile, 'Preferences'), update.preferences);
}
