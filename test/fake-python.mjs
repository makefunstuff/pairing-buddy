// A stand-in for the user's Python, for the tests of search by meaning's runtime install (runtime.mjs): no real
// Python, pip or network. `fakePython(options)` writes a `python3` that answers what Pair asks of one: its version and
// whether it can make a venv, `-m venv DIR` (a venv whose `bin/python` is another fake, with the same options), and in
// that venv `-m pip --version`, `-m pip install ... -r LOCK` (its arguments noted in DIR/pip.json, raw progress lines
// printed, then litert-lm-api "installed") and the probe for litert_lm.
//
// options: {version: '3.12', venv: true (has the venv module), pip: '25.0', pipError: 'ERROR: ...' (pip fails so),
// pipHangs: false (pip waits until it is killed), bytes: 3 << 20 (the wheel's size, for progress)}
import {chmodSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scratch} from './temp.mjs';

const RUN = fileURLToPath(new URL('./fake-python-run.mjs', import.meta.url));

/** Writes the wrapper `<dir>/<name>` that runs fake-python-run.mjs as Python with `options`. */
function wrapper(dir, name, options) {
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(options));
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${RUN}" "${join(dir, `${name}.json`)}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A fake `python3` with `options`, in a folder of its own. */
export const fakePython = (options = {}) => wrapper(scratch('fake-python-'), 'python3', options);
