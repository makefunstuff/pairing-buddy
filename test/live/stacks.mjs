// The model stacks the live tests run against, from PAIR_LIVE_CONFIG or the gitignored test/live/config.json:
//   {"stacks": [{"name": "local", "watcher": {<model entry>}, "partner": {<model entry>}}]}
// Model entries are the same as in the daemon config (see README). Without a file, live tests skip.
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {modelConfig} from '../../src/config.mjs';
import {createPairModels} from '../../src/models.mjs';

const DEFAULT = fileURLToPath(new URL('./config.json', import.meta.url));

export function liveStacks() {
  const path = process.env.PAIR_LIVE_CONFIG || DEFAULT;
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')).stacks.map(stack => {
    const config = {models: {watcher: modelConfig('watcher', stack.watcher), partner: modelConfig('partner', stack.partner)}};
    return {name: stack.name, config, ...createPairModels(config)};
  });
}

export const SKIP_REASON = 'no live model stacks: set PAIR_LIVE_CONFIG (see test/live/stacks.mjs)';
