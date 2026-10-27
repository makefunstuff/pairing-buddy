// fzf-lua for the plugin tests: the real plugin at a pinned commit, fetched once into node_modules/.cache (ignored
// by git) and kept there for the next runs. It needs git, the network the first time, and fzf itself to run.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, renameSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const FZF_LUA = '5b88d6f0af7fcb41d4a8bb340bf70d7e3824ee9d'; // ibhagwan/fzf-lua, MIT: run by the tests, never shipped
const CACHE = fileURLToPath(new URL('../node_modules/.cache/pair-test/', import.meta.url));

const has = command => { try { execFileSync(command, ['--version'], {stdio: 'ignore'}); return true; } catch { return false; } };

/** fzf-lua's directory, for Neovim's runtimepath, or why there is none: {dir} or {skip}. */
export function fzfLua() {
  if (!has('fzf')) return {skip: 'fzf not installed'};
  const dir = join(CACHE, `fzf-lua-${FZF_LUA}`);
  if (existsSync(join(dir, 'lua', 'fzf-lua', 'init.lua'))) return {dir};
  const fetching = `${dir}.fetching-${process.pid}`; // not a temp dir: the cache's own, gone once fetched or failed
  mkdirSync(fetching, {recursive: true});
  try {
    const git = (...args) => execFileSync('git', ['-C', fetching, ...args], {stdio: 'ignore', timeout: 60_000});
    git('init', '-q');
    git('fetch', '-q', '--depth', '1', 'https://github.com/ibhagwan/fzf-lua', FZF_LUA);
    git('checkout', '-q', 'FETCH_HEAD');
    rmSync(join(fetching, '.git'), {recursive: true, force: true});
    if (!existsSync(dir)) renameSync(fetching, dir); // another test run may have fetched it meanwhile
    return {dir};
  } catch (error) {
    return {skip: `fzf-lua could not be fetched: ${error.message.split('\n')[0]}`};
  } finally {
    rmSync(fetching, {recursive: true, force: true});
  }
}
