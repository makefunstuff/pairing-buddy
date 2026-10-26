// The version of this install, from package.json: the daemon reports it, so `pair doctor` can tell an old one.
import {readFileSync} from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
