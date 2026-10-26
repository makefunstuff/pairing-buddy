// Where the editor shows a build or run that run-output.mjs read: the crash on the line of its frame in the
// project's code, each compiler error and warning on its line. Only files of the project that exist are shown.
import {access} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {crashText, warningKey} from './run-output.mjs';

const MAX_PLACES = 30;

/** The absolute path of `file`, relative to `root` as readRun gives files of the project, or null when it is no such file. */
async function projectPath(root, file) {
  if (isAbsolute(file)) return null;
  const path = join(root, file);
  return access(path).then(() => path, () => null);
}

/**
 * The places of `run` (a reading of run-output.mjs, with `newWarnings`), each `{file, line, col, kind, text, new}`:
 * kind 'crash', 'error' or 'warning', absolute paths inside `root`. A warning is `new` when the builds before did
 * not print it. They come in the order the jump key prefers: the crash, the errors, then the warnings.
 */
export async function placeRun(run, root) {
  const fresh = new Set((run.newWarnings ?? []).map(warningKey));
  const candidates = [
    ...(run.crash?.at ? [{...run.crash.at, col: null, kind: 'crash', text: crashText(run.crash)}] : []),
    ...run.errors.map(error => ({...error, kind: 'error', text: error.message})),
    ...run.warnings.map(warning => ({...warning, kind: 'warning', text: warning.message, new: fresh.has(warningKey(warning))})),
  ];
  const places = [];
  for (const place of candidates.filter(candidate => candidate.file).slice(0, MAX_PLACES)) {
    const file = await projectPath(root, place.file);
    if (file) places.push({file, line: place.line, col: place.col ?? null, kind: place.kind, text: place.text, new: !!place.new});
  }
  return places;
}
