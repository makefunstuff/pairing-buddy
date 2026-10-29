// Owning generated code: code taken from a /gen request is marked ┊ in Neovim's sign column, part by part, until it is
// the user's. A part is a run of the taken lines between blank lines (a function, a block of statements); editing a
// line of it yourself makes that part yours, and :Pair own makes a range, a file or everything yours at once.
//
// The ledger keeps each part with the request's piece: its text and the line it was last seen on, so a buffer
// loaded again (Neovim restarted, the buffer reloaded) finds its parts again by their text within NEAR lines, as the
// marks in a note's margin are found. A part whose text is no longer there is gone: neither yours nor Pair's.
// Owned and gone parts stay in the ledger, for pair stats; the ledger keeps a request's pieces for seven days
// (DETAIL_KEPT_MS), so a part not owned by then is no longer marked.

export const NEAR = 20; // a part whose line moved this far or less is still found by its text

const lineList = text => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** The parts of `text`, taken at line `line` (1-based): its runs of lines between blank lines, as {line, text}. */
export function partsOf(text, line) {
  const parts = [];
  lineList(text).forEach((one, i) => {
    if (!one.trim()) return;
    const last = parts.at(-1);
    if (last && last.line + last.text.length === line + i) last.text.push(one);
    else parts.push({line: line + i, text: [one]});
  });
  return parts;
}

/** The 1-based line of `lines` where `part` starts, nearest to `line` within NEAR lines; null when it is gone. */
export function findPart(lines, part, line) {
  const at = start => part.text.every((one, i) => lines[start + i] === one);
  for (let d = 0; d <= NEAR; d++) {
    for (const start of d ? [line - 1 - d, line - 1 + d] : [line - 1]) {
      if (start >= 0 && start + part.text.length <= lines.length && at(start)) return start + 1;
    }
  }
  return null;
}

/**
 * The marks of `text` as written to a file (`written`, which the user may have changed while it was a buffer to
 * review): the parts of `text` still there are Pair's, the others the user's already, owned by `review`.
 */
export function writtenMarks(text, written, at) {
  const lines = lineList(written);
  return partsOf(text, 1).map((part, k) => {
    const found = findPart(lines, part, part.line);
    return found ? {k, line: found, text: part.text, state: 'generated'} : {k, line: part.line, text: part.text, state: 'owned', how: 'review', at};
  });
}

/** The marks of code taken at line `from`: each part of `text`, Pair's. */
export const takenMarks = (text, from) => partsOf(text, from).map((part, k) => ({k, ...part, state: 'generated'}));

/** A mark's id, as Neovim and the daemon name it: ledger entry, piece and part. */
export const markId = (action, piece, k) => `${action}.${piece}.${k}`;

/** The ledger entry, piece and part of mark `id`; null for anything else. */
export function parseMarkId(id) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(typeof id === 'string' ? id : '');
  return match ? {action: Number(match[1]), piece: Number(match[2]), k: Number(match[3])} : null;
}

/** The lines of a request's `pieces` by what became of them: taken (all marked), owned, gone, and not yours yet. */
export function markedLines(pieces) {
  const lines = {taken: 0, owned: 0, gone: 0, generated: 0};
  for (const piece of pieces) {
    if (piece.state !== 'taken') continue;
    for (const mark of piece.marks ?? []) {
      lines.taken += mark.text.length;
      lines[mark.state] += mark.text.length;
    }
  }
  return lines;
}

/**
 * What pair stats counts of a request, booked in its ledger entry's data as `counts`: its pieces taken and dropped,
 * and its lines (markedLines).
 */
export const tally = pieces => ({
  counts: {
    taken: pieces.filter(piece => piece.state === 'taken').length, dropped: pieces.filter(piece => piece.state === 'dropped').length,
    lines: markedLines(pieces),
  },
});
