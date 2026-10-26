// What a file is about, in a line or two: its leading comment and the names it defines. The Watcher judges drift
// from it, so a file is on or off the goal by what it does, not by the words of its path. Pure: no files read here.

const MAX_CHARS = 240;
const MAX_NAMES = 8;
const LOOKED_AT = 80; // lines from the top: a file says what it is near its start

// A line of a comment, with its marker: //, /*, *, #, --, ;, or a docstring's quotes.
const COMMENT = /^\s*(?:\/\/+!?|\/\*+|\*+\/?|#(?!include|define|if|pragma|!)|--|;+|"""|''')\s?(.*?)\s*(?:\*\/|"""|''')?\s*$/;
// Lines that say nothing of what the file does.
const PREAMBLE = /^\s*(?:$|#!|['"]use strict['"]|package\s|import\s|from\s+\S+\s+import|use\s|#include|require\(|const\s+\{?[\w\s,]*\}?\s*=\s*require\()/;
const LICENSE = /copyright|spdx|licen[cs]e|all rights reserved/i;
// A definition in most languages: function, class, def, fn, func, type, interface, struct, enum, trait, or a const.
const DEFINES = /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\(\w+\))?\s+)?(?:async\s+)?(?:function\*?|class|def|fn|func(?:\s+\([^)]*\))?|type|interface|struct|enum|trait|module|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** The text of the first comment of `lines` above the code, without markers; a licence does not count. */
function leadingComment(lines) {
  let found = [];
  const text = () => found.join(' ').replace(/\s+/g, ' ').trim();
  for (const line of lines) {
    const comment = COMMENT.exec(line);
    if (comment) { if (comment[1]) found.push(comment[1]); continue; }
    if (found.length && !LICENSE.test(text())) break;
    found = [];
    if (!PREAMBLE.test(line)) break;
  }
  return LICENSE.test(text()) ? '' : text();
}

/** One or two lines on what `text` (a file's content) is about; '' when it says nothing. */
export function gist(text) {
  const lines = String(text ?? '').split('\n').slice(0, LOOKED_AT);
  const names = [...new Set(lines.map(line => DEFINES.exec(line)?.[1]).filter(Boolean))].slice(0, MAX_NAMES);
  const parts = [leadingComment(lines), names.length ? `It defines ${names.join(', ')}.` : ''].filter(Boolean);
  const said = parts.join(' ');
  return said.length > MAX_CHARS ? `${said.slice(0, MAX_CHARS - 1)}…` : said;
}
