// The tests Pair runs when you save: the command you set for the project (`testOnSave` in the config), typed in
// Pair's own pane like Scout's commands. Its output goes to a file, so a long run is read back whole and the pane
// stays readable. The model never chooses or starts a run. After the Driver's edit, the same command runs once on
// the unsaved buffers (see unsaved.mjs).
// Only the latest save counts: a save during a run stops that run and starts one for every file saved since the last
// run that ended. Once a run has given the baseline, a run covers only the tests the saved files can affect, where
// the runner can be told (see affected.mjs).
import {createHash} from 'node:crypto';
import {readFile, rm, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {affectedCommand} from './affected.mjs';
import {readRun} from './run-output.mjs';
import {RUN_TIMEOUT_MS, shellQuote} from './scout-pane.mjs';
import {isSourceFile, parseTestOutput} from './test-output.mjs';
import {placeTests} from './test-places.mjs';
import {reportFileOf} from './test-reports.mjs';
import {pictureSince, prepareUnsaved, withTree} from './unsaved.mjs';

/** How a command reads in the statusline: without the flags that only ask for a JSON report. */
export const runLabel = command => command.replace(/\s+(?:-json|--json|--reporter[= ]json)(?=\s|$)/g, '');

/**
 * What the pane runs: `command` in `root`, the output and errors of all of it to `outputFile`, also of a list
 * like `cc -o probe probe.c && ./probe`. The pane's shell is shared with Scout, whose commands may have changed
 * its directory.
 */
export const runLine = (command, root, outputFile) => `cd ${shellQuote(root)} && (${command}) > ${shellQuote(outputFile)} 2>&1`;

/** The copy of the project at `root` that runs on unsaved buffers use, kept in `runsDir` (see unsaved.mjs). */
export const treeOf = (runsDir, root) => join(runsDir, 'trees', createHash('sha256').update(root).digest('hex').slice(0, 16));

/** The JUnit report `command` wrote while it ran in `root` since `since` (ms), or null. */
async function reportOf(command, root, since) {
  const written = reportFileOf(command);
  if (!written) return null;
  const testDir = /--test-dir[= ](\S+)/.exec(command)?.[1]; // ctest writes its report relative to the build folder
  const path = isAbsolute(written) ? written : join(root, testDir && /--output-junit/.test(command) ? testDir : '', written);
  const info = await stat(path).catch(() => null);
  return info && info.mtimeMs >= since - 1000 ? readFile(path, 'utf8').catch(() => null) : null;
}

/** What a finished run in `root` found: its output, tests, their places and its reading (see the constructor). */
async function readResult({command, root, outputFile, started, exit, texts}) {
  const output = await readFile(outputFile, 'utf8').catch(() => '');
  const tests = parseTestOutput(output, await reportOf(command, root, started));
  const placed = tests?.tests ? await placeTests(tests.tests, root, texts) : [];
  return {output, tests, placed, reading: readRun(output, {exit, root})};
}

export class TestRuns {
  /**
   * `pane()` is Pair's pane (a ScoutPane), or null without herdr. `report(run)` hears of each run twice:
   * `{state: 'run', label, saved}` as it starts, then `{state: 'done', label, saved, exit, timedOut, timeoutMs, output, tests, placed, reading, narrowed}`
   * (`tests` as parseTestOutput gives them, `placed` as placeTests does, `reading` as readRun does: a build's
   * errors, a crash; `narrowed` when it ran only the tests the saved files affect), or
   * `{state: 'error', label, saved, error, short}`. A run stopped by a later save reports nothing more.
   * A run on unsaved text has `unsaved: true` in each. `timeoutMs` stops a run that takes longer; `affected: false`
   * always runs the whole command.
   */
  constructor({root, command, outputFile, pane, report, timeoutMs = RUN_TIMEOUT_MS, affected = true}) {
    Object.assign(this, {root, command, outputFile, pane, report, timeoutMs, affected});
    this.label = runLabel(command);
    this.tree = treeOf(dirname(outputFile), root);
    this.running = null; // the run under way: {stop()}
    this.pending = new Set(); // files saved since the last run that ended, relative to the root
    this.lastSaved = null;
    this.baseline = false; // whether a whole run has ended, so later ones may run only what a save affects
    this.wholeNext = false; // the next run runs whole, whatever was saved
  }

  /**
   * Runs the whole command next, now when nothing runs: what a narrowed run cannot say, such as whether a test that
   * failed before still exists, a whole run does.
   */
  runWhole() {
    this.wholeNext = true;
    if (!this.running) this.run();
  }

  /** The user saved `file` (relative to the root): a source file starts a run, and stops one under way. */
  saved(file) {
    if (!isSourceFile(file)) return;
    this.pending.add(file);
    this.lastSaved = file;
    if (this.running) this.running.stop();
    else this.run();
  }

  async run() {
    const files = [...this.pending];
    const saved = this.lastSaved;
    this.pending.clear();
    const pane = this.pane();
    if (!pane) return this.report({state: 'error', label: this.label, saved, error: 'tests on save need Pair\'s own herdr pane: start Pair with `pair` inside herdr', short: 'needs `pair` in herdr'});
    const controller = new AbortController();
    this.running = {stop: () => controller.abort()};
    const whole = this.wholeNext;
    this.wholeNext = false;
    let cancelled = false;
    try {
      const narrowed = this.affected && this.baseline && !whole ? await affectedCommand({command: this.command, root: this.root, files}) : null;
      const command = narrowed ?? this.command;
      const label = runLabel(command);
      this.report({state: 'run', label, saved});
      const started = Date.now();
      const ran = await pane.run(runLine(command, this.root, this.outputFile), {timeoutMs: this.timeoutMs, signal: controller.signal});
      cancelled = ran.cancelled;
      if (cancelled) return;
      const {exit, timedOut} = ran;
      const result = await readResult({command, root: this.root, outputFile: this.outputFile, started, exit});
      if (!narrowed && !timedOut) this.baseline = true;
      this.report({state: 'done', label, saved, exit, timedOut, timeoutMs: this.timeoutMs, ...result, narrowed: !!narrowed});
    } catch (error) {
      this.report({state: 'error', label: this.label, saved, error: error.message, short: 'could not run'});
    } finally {
      this.running = null;
      // A stopped run's files run again with the ones saved since; a whole run asked for is still asked for.
      if (cancelled) for (const file of files) this.pending.add(file);
      if (cancelled && whole) this.wholeNext = true;
      if (this.pending.size || this.wholeNext) this.run();
    }
  }

  /**
   * Runs the command once on `texts` (absolute file -> text: the unsaved buffers, with the Driver's edit in `file`),
   * without saving anything, and resolves with what it reports at the end, and the `picture` the run wrote in the
   * scratch copy, if any (see pictureSince). Pair's pane runs one command at a time, so it waits for a run on save.
   */
  async unsaved(file, texts) {
    const report = run => { this.report({...run, label: this.label, saved: file, unsaved: true}); return {...run, label: this.label}; };
    const pane = this.pane();
    if (!pane) return report({state: 'error', error: 'the tests need Pair\'s own herdr pane', short: 'needs `pair` in herdr'});
    report({state: 'run'});
    const dir = `${this.outputFile}.unsaved`;
    try {
      return await withTree(this.tree, async () => {
        const run = await prepareUnsaved({root: this.root, command: this.command, texts, dir, tree: this.tree});
        if (run.left.includes(file)) throw new Error(`${file.slice(this.root.length + 1)} is in a dependency folder`);
        const outputFile = join(dir, 'run.out');
        const started = Date.now();
        const {exit, timedOut} = await pane.run(runLine(run.command, run.root, outputFile), {timeoutMs: this.timeoutMs});
        const picture = run.root === this.root ? null : await pictureSince(run.root, started);
        const result = await readResult({command: run.command, root: run.root, outputFile, started, exit, texts: run.texts});
        const placed = result.placed.map(test => ({
          ...test,
          file: run.toProject(test.file),
          failure: test.failure && {...test.failure, file: run.toProject(test.failure.file)},
        }));
        return {...report({state: 'done', exit, timedOut, timeoutMs: this.timeoutMs, ...result, placed}), picture};
      });
    } catch (error) {
      return report({state: 'error', error: error.message, short: 'could not run'});
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  }
}
