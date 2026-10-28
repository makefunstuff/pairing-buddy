// What you sent in the chat pane, per project, so Up finds it again after the pane closed: the last MAX lines of
// each project in one small JSON file in the data directory. A file that cannot be read is an empty history.
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const MAX = 200;

/** The history in `file`: `of(root)` lists a project's lines, oldest first; `add(root, line)` keeps one more. */
export function openHistory(file, {max = MAX} = {}) {
  let roots = {};
  try {
    const read = JSON.parse(readFileSync(file, 'utf8'));
    if (read && typeof read.roots === 'object') roots = read.roots;
  } catch {}
  return {
    of: root => (Array.isArray(roots[root]) ? roots[root].filter(line => typeof line === 'string') : []),
    add(root, line) {
      const lines = (roots[root] ?? []).filter(old => old !== line);
      lines.push(line);
      roots[root] = lines.slice(-max);
      try {
        mkdirSync(dirname(file), {recursive: true});
        writeFileSync(`${file}.tmp`, JSON.stringify({roots}));
        renameSync(`${file}.tmp`, file);
      } catch {} // a history that cannot be written is only lost
    },
  };
}
