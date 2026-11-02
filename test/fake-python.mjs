// A stand-in for the user's Python, for the tests of search by meaning's runtime install (runtime.mjs): no real
// Python, pip or network. `fakePython(options)` writes a `python3` that answers what Pair asks of one: its version and
// whether it can make a venv, `-m venv DIR` (a venv whose `bin/python` is another fake, with the same options), and in
// that venv `-m pip install ... -r LOCK` (its arguments and the wheels it was given noted in DIR/pip.json, then
// litert-lm-api "installed") and the probe for litert_lm. `fakeWheel()` is a wheel to download for it, and its fetch.
//
// options: {version: '3.12', venv: true (has the venv module), pipError: 'ERROR: ...' (pip fails so),
// pipHangs: false (pip waits until it is killed)}
import {createHash} from 'node:crypto';
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

/**
 * A wheel of `bytes` for Runtime's `wheel`, pinned by its own SHA-256, and a `fetch` that serves it in pieces;
 * `fetched` lists the URLs asked for. `fail` makes the fetch throw as an unreachable host does.
 */
export function fakeWheel({bytes = 3 << 20, fail = null} = {}) {
  const body = Buffer.alloc(bytes, 7);
  const wheel = {url: 'https://files.pythonhosted.org/packages/00/00/litert_lm_api-0.19.0-py3-none-manylinux_2_27_x86_64.whl', bytes, sha256: createHash('sha256').update(body).digest('hex')};
  const fetched = [];
  const fetch = async url => {
    fetched.push(url);
    if (fail) throw Object.assign(new TypeError('fetch failed'), {cause: {code: fail}});
    return new Response(new ReadableStream({
      start(controller) {
        for (let at = 0; at < body.length; at += 1 << 20) controller.enqueue(body.subarray(at, at + (1 << 20)));
        controller.close();
      },
    }));
  };
  return {wheel, fetch, fetched};
}
