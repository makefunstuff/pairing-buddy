// The folder a session belongs to. A project is its git root, so each git worktree has its own session; in a
// monorepo, `sessionRoots` in the config names smaller ones: a folder, or `<folder>/*` for each folder in it.
import {relative, sep} from 'node:path';

const inside = (dir, root) => dir === root || dir.startsWith(root + sep);

/**
 * The session root `roots` give `dir` (a real path), the deepest when several do; null when none does. Each root is
 * `{path}`, or `{path, each: true}` for every folder directly in `path`.
 */
export function sessionRootOf(dir, roots) {
  const found = roots.map(({path, each}) => {
    if (!each) return inside(dir, path) ? path : null;
    const [first] = inside(dir, path) ? relative(path, dir).split(sep) : [];
    return first ? path + sep + first : null;
  });
  return deepest(found.filter(Boolean));
}

/** The longest of `paths`, or null when there is none. */
export const deepest = paths => paths.reduce((best, path) => (path.length > (best?.length ?? -1) ? path : best), null);

/** The open session root that contains `dir`, the deepest when several do; null when none does. */
export const openRootOf = (dir, roots) => deepest([...roots].filter(root => inside(dir, root)));
