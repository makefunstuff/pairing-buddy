// Reads what a build or a run printed, the way test-output.mjs reads a test run: whether it crashed and where,
// and the compiler's errors and warnings with their file and line. Pure: no files, no clock.
//
// Crashes: the signal in the exit code (139 is SIGSEGV) or in the shell's or make's words ("Segmentation fault
// (core dumped)"), sanitizer reports, glibc's failed assert, Zig's panic and its stack, Odin's runtime assertions
// and bounds checks, C3's runtime errors, and a gdb backtrace. Diagnostics: gcc and clang (`file:line:col: error:`,
// which Zig and Odin's unix style print too), Odin (`file(line:col) Error:`) and c3c (`(file:line:col) Error:`).
import {isAbsolute, relative, resolve, sep} from 'node:path';

const MAX_DIAGNOSTICS = 50;

// The signals a program dies of by its own fault. Ctrl-C, a kill and a closed pipe are no crash.
const SIGNALS = {4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 11: 'SIGSEGV'};
const SIGNAL_NAMES = {
  SIGILL: 'Illegal instruction', SIGTRAP: 'Trace/breakpoint trap', SIGABRT: 'Aborted', SIGBUS: 'Bus error',
  SIGFPE: 'Floating point exception', SIGSEGV: 'Segmentation fault',
};
// How bash and make (bash's words) and zsh (its own, lowercased) say a program died of a signal.
const SIGNAL_WORDS = {
  'Segmentation fault': 'SIGSEGV', 'Aborted': 'SIGABRT', 'Bus error': 'SIGBUS', 'Floating point exception': 'SIGFPE',
  'Illegal instruction': 'SIGILL', 'Trace/breakpoint trap': 'SIGTRAP',
  'segmentation fault': 'SIGSEGV', 'abort': 'SIGABRT', 'bus error': 'SIGBUS', 'floating point exception': 'SIGFPE',
  'illegal hardware instruction': 'SIGILL', 'trace trap': 'SIGTRAP',
};
const words = names => names.map(word => word.replace('/', '\\/')).join('|');
const BASH = words(Object.keys(SIGNAL_WORDS).filter(word => /^[A-Z]/.test(word)));
const ZSH = words(Object.keys(SIGNAL_WORDS).filter(word => /^[a-z]/.test(word)));
const CORE = String.raw`(?: +\(core dumped\))?`;
// Only whole lines in the form each prints, so a program's own "Aborted transaction" is no crash.
const SIGNAL_LINES = [
  new RegExp(`^(${BASH})${CORE}$`), // bash at the prompt: "Segmentation fault (core dumped)"
  new RegExp(String.raw`^.*: line \d+: +\d+ (${BASH})${CORE}(?: .*)?$`), // bash in a script: "bash: line 1: 4242 Segmentation fault  (core dumped) ./probe"
  new RegExp(String.raw`^make(?:\[\d+\])?: \*\*\* \[.*\] (${BASH})${CORE}$`), // "make: *** [Makefile:2: run] Segmentation fault (core dumped)"
  new RegExp(String.raw`^\S*zsh: (${ZSH})${CORE}(?:\s{2,}.*)?$`), // "zsh: abort (core dumped)  ./probe"
  /^(Segmentation fault) at address \S+$/, // Zig
];
// make's "Error 139" when the shell it started ended with the program's signal.
const MAKE_ERROR = /^make(?:\[\d+\])?: \*\*\* \[.*\] Error (\d+)$/;

/** The signal of exit code `exit` (128 + its number, as shells give it), if it is one a program crashes of. */
export const exitSignal = exit => (Number.isInteger(exit) && exit > 128 ? SIGNALS[exit - 128] ?? null : null);

/** The signal a run died of. A run known to have ended with exit 0 died of none, whatever it printed. */
function signalOf(lines, exit) {
  if (exit === 0) return null;
  for (const line of lines) {
    const word = SIGNAL_LINES.map(pattern => pattern.exec(line.trim())?.[1]).find(Boolean);
    if (word) return SIGNAL_WORDS[word];
    const made = MAKE_ERROR.exec(line.trim());
    if (made && exitSignal(Number(made[1]))) return exitSignal(Number(made[1]));
  }
  return exitSignal(exit);
}

// Stack frames, as {file, line, function}: each pattern gives them in that order of groups.
const FRAMES = [
  /^\s*#\d+ 0x[0-9a-f]+ in (\S+) (\/?[^\s:()]+):(\d+)/, // a sanitizer: "#0 0x55.. in probe /src/probe.c:10:5"
  /^#\d+\s+(?:0x[0-9a-f]+ in )?(\S+) \(.*\) at ([^\s:]+):(\d+)/, // gdb: "#1  0x.. in probe (t=0x..) at probe.c:10"
  /^(\/?[^\s:]+\.zig):(\d+):\d+: 0x[0-9a-f]+ in (\S+)/, // Zig: "/src/main.zig:4:16: 0x113fb8d in probe (main.zig)"
  /^\s+in (\S+) \(([^\s:()]+\.c3):(\d+)\)/, // C3: "  in main (/src/main.c3:5) [./main]"
];

function frameOf(line) {
  for (const [index, pattern] of FRAMES.entries()) {
    const match = pattern.exec(line);
    if (!match) continue;
    const [fn, file, at] = index === 2 ? [match[3], match[1], match[2]] : match.slice(1);
    return {file, line: Number(at), function: fn};
  }
  return null;
}

// Reports that say what went wrong, with the place it went wrong at when they name one.
const REPORTS = [
  // glibc's assert: "probe: probe.c:16: main: Assertion `t.keys != NULL' failed."
  {pattern: /^\S+: ([^\s:]+):(\d+): (\S+): (Assertion .* failed)\.?$/, read: m => ({text: m[4], place: {file: m[1], line: Number(m[2]), function: m[3]}})},
  // A sanitizer: "==4242==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x7b.. at pc 0x56.."
  {pattern: /^==\d+==ERROR: (\w+Sanitizer: \S+)/, read: m => ({text: m[1]})},
  // UBSan: "probe.c:12:5: runtime error: signed integer overflow: ..."
  {pattern: /^([^\s:]+):(\d+):\d+: runtime error: (.+)$/, read: m => ({text: `runtime error: ${m[3]}`, place: {file: m[1], line: Number(m[2])}})},
  // Zig: "thread 2359401 panic: index out of bounds: index 4, len 3"
  {pattern: /^thread \d+ (panic: .+)$/, read: m => ({text: m[1]})},
  // Odin: "/src/main.odin(7:5) Index 4 is out of range 0..<3", "(7:2) runtime assertion: ...", "(7:2) Panic: ..."
  {pattern: /^(\S+\.odin)\((\d+):\d+\) (?!(?:Syntax )?(?:Error|Warning):)(.+)$/, read: m => ({text: m[3], place: {file: m[1], line: Number(m[2])}})},
  // C3: "ERROR: 'Array index out of bounds (array had size 3, index was 4)'"
  {pattern: /^ERROR: '(.+)'$/, read: m => ({text: m[1]})},
];

/**
 * `{signal, text, frames}` when the run crashed, else null. `text` is one line: the report's own words when
 * there is a report, else the signal's name. `frames` are the places of its first stack, innermost first, as
 * printed; a blank line ends it (a sanitizer's next stack is where the memory was allocated or freed).
 */
function crashOf(entries, exit) {
  const signal = signalOf(entries.map(entry => entry.text), exit);
  let report = null;
  const frames = [];
  let stackDone = false;
  for (const {text: line, dir} of entries) {
    if (!line.trim() && frames.length) stackDone = true;
    if (!report) {
      for (const {pattern, read} of REPORTS) {
        const match = pattern.exec(line.trimEnd());
        if (match) {
          report = read(match);
          if (report.place) frames.push({...report.place, dir});
          break;
        }
      }
    }
    const found = !stackDone && frameOf(line);
    const frame = found && {...found, dir};
    if (frame && !frames.some(other => other.file === frame.file && other.line === frame.line)) frames.push(frame);
  }
  if (!signal && !report) return null;
  return {signal, text: report?.text ?? SIGNAL_NAMES[signal], frames};
}

// Compiler diagnostics: [file, line, col, severity, message] from each pattern.
const DIAGNOSTICS = [
  /^([^\s:()][^\s:]*):(\d+):(\d+): (fatal error|error|warning|Error|Warning|Syntax Error): (.+)$/, // gcc, clang, zig, odin -error-pos-style:unix
  /^([^\s:]+):(\d+)():? (error|warning): (.+)$/, // gcc without a column
  /^(\S+\.odin)\((\d+):(\d+)\) (Error|Warning|Syntax Error|Syntax Warning): (.+)$/, // odin
  /^\((\S+?):(\d+):(\d+)\) (Error|Warning): (.+)$/, // c3c
];
// The linker names no line, only what is missing: "/usr/bin/ld: cannot find -lm", "link.c:(.text+0x5): undefined
// reference to `foo'", and lld's "ld.lld: error: undefined symbol: foo".
const LINKER = /^(?:(?:\S*\/)?(?:ld|ld\.\w+|lld): (?:error: )?|[^\s:]+:\(\.[\w.]+\+0x[0-9a-f]+\): )(.*(?:undefined reference|undefined symbol|cannot find|multiple definition|duplicate symbol).*)$/;

function diagnosticsOf(entries) {
  const found = [];
  const seen = new Set();
  for (const {text: line, dir} of entries) {
    const text = line.trimEnd();
    let diagnostic = null;
    for (const pattern of DIAGNOSTICS) {
      const match = pattern.exec(text);
      if (!match) continue;
      const [, file, at, col, severity, message] = match;
      diagnostic = {file, line: Number(at), col: col ? Number(col) : null, severity: /warning/i.test(severity) ? 'warning' : 'error', message: message.trim(), dir};
      break;
    }
    const linker = !diagnostic && LINKER.exec(text);
    if (linker) diagnostic = {file: null, line: null, col: null, severity: 'error', message: linker[1].trim(), dir};
    const key = diagnostic && `${diagnostic.dir}/${diagnostic.file}:${diagnostic.line}:${diagnostic.message}`;
    if (!diagnostic || seen.has(key)) continue; // make -j and headers included twice print the same one again
    seen.add(key);
    found.push(diagnostic);
  }
  return found.slice(0, MAX_DIAGNOSTICS);
}

// make, before and after it runs in another folder (`make -C src`, a sub-make): its compilers name files from there.
const MAKE_DIRECTORY = /^\S*make(?:\[\d+\])?: (Entering|Leaving) directory ['‘`](.+)['’]$/;

/** Each line with the folder make said it works in for it, or null outside any. */
function withDirectories(lines) {
  const stack = [];
  return lines.map(text => {
    const move = MAKE_DIRECTORY.exec(text.trim());
    if (move?.[1] === 'Entering') stack.push(move[2]);
    if (move?.[1] === 'Leaving') stack.pop();
    return {text, dir: stack.at(-1) ?? null};
  });
}

/**
 * What a run printed: `{crash, errors, warnings}`. `crash` is `{signal, text, frames, at}` or null (see crashOf),
 * where `at` is its innermost frame in the project's own code: the place the user can do something about, not
 * libc's or the runtime's. `errors` and `warnings` are the compiler's, each `{file, line, col, severity, message}`,
 * with a null file and line for the linker's. `exit` is the run's exit code, when known. With the project's
 * `root`, and the `cwd` the run started in (by default the root), files in the project are given relative to its
 * root and others as absolute paths; without, as printed. A file make named from another folder is taken from there.
 */
export function readRun(output = '', {exit = null, root = null, cwd = root} = {}) {
  const entries = withDirectories(output.replace(/\x1b\[[0-9;]*m/g, '').split('\n'));
  const inRoot = ({dir, ...item}) => {
    if (!root || !item.file) return item;
    const path = resolve(cwd ?? root, dir ?? '.', item.file);
    return {...item, file: path.startsWith(root + sep) ? relative(root, path) : path};
  };
  const diagnostics = diagnosticsOf(entries).map(inRoot);
  const crash = crashOf(entries, exit);
  const frames = crash?.frames.map(inRoot);
  return {
    crash: crash && {...crash, frames, at: frames.find(frame => !isAbsolute(frame.file) && !frame.file.startsWith('../')) ?? null},
    errors: diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    warnings: diagnostics.filter(diagnostic => diagnostic.severity === 'warning'),
  };
}

/** Whether a reading found anything: a crash or a diagnostic. */
export const hasNews = reading => !!(reading.crash || reading.errors.length || reading.warnings.length);

/** A warning without its line, which moves as the file is edited: the same warning in the next build has the same key. */
export const warningKey = warning => `${warning.file}: ${warning.message}`;

const where = place => `${place.file.split('/').at(-1)}:${place.line}`;
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What crashed, in a few words: "Segmentation fault", "panic: index out of bounds: index 4, len 3 (SIGABRT)". */
export function crashText({signal, text}) {
  return signal && text !== SIGNAL_NAMES[signal] ? `${text} (${signal})` : text;
}

/** One line for the models and the chat: "Segmentation fault at probe.c:10 in probe", or "2 errors: bad.c:3: ...". */
export function readingSummary({crash, errors, warnings}) {
  if (crash) return `${crashText(crash)}${crash.at ? ` at ${where(crash.at)}${crash.at.function ? ` in ${crash.at.function}` : ''}` : ''}`;
  const [first] = errors;
  if (first) return `${count(errors.length, 'error')}: ${first.file ? `${where(first)}: ` : ''}${first.message}`;
  if (warnings.length) return `${count(warnings.length, 'warning')}: ${where(warnings[0])}: ${warnings[0].message}`;
  return '';
}
