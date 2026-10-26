// The tests Pair runs when you save: the command you set for the project (`testOnSave` in the config), typed in
// Pair's own pane like Scout's commands. Its output goes to a file, so a long run is read back whole and the pane
// stays readable. The model never chooses or starts a run.
import {readFile} from 'node:fs/promises';
import {shellQuote} from './scout-pane.mjs';
import {isSourceFile, parseTestOutput} from './test-output.mjs';
import {placeTests} from './test-places.mjs';

/** How a command reads in the statusline: without the flags that only ask for a JSON report. */
export const runLabel = command => command.replace(/\s+(?:-json|--json|--reporter[= ]json)(?=\s|$)/g, '');

/** What the pane runs: `command`, its output and errors to `outputFile`. */
export const runLine = (command, outputFile) => `${command} > ${shellQuote(outputFile)} 2>&1`;

export class TestRuns {
  /**
   * `pane()` is Pair's pane (a ScoutPane), or null without herdr. `report(run)` hears of each run twice:
   * `{state: 'run', label, saved}` as it starts, then `{state: 'done', label, saved, exit, timedOut, tests, placed}`
   * (`tests` as parseTestOutput gives them, `placed` as placeTests does), or `{state: 'error', label, saved, error}`.
   */
  constructor({root, command, outputFile, pane, report}) {
    Object.assign(this, {root, command, outputFile, pane, report});
    this.label = runLabel(command);
    this.running = false;
    this.next = null; // a file saved during a run: one more run follows it, for the last such save
  }

  /** The user saved `file` (relative to the root): a source file starts a run, or one more after the running one. */
  saved(file) {
    if (!isSourceFile(file)) return;
    if (this.running) this.next = file;
    else this.run(file);
  }

  async run(saved) {
    const pane = this.pane();
    if (!pane) return this.report({state: 'error', label: this.label, saved, error: 'tests on save need Pair\'s own herdr pane: start Pair with `pair` inside herdr'});
    this.running = true;
    this.report({state: 'run', label: this.label, saved});
    try {
      const {exit, timedOut} = await pane.run(runLine(this.command, this.outputFile));
      const tests = parseTestOutput(await readFile(this.outputFile, 'utf8').catch(() => ''));
      const placed = tests?.tests ? await placeTests(tests.tests, this.root) : [];
      this.report({state: 'done', label: this.label, saved, exit, timedOut, tests, placed});
    } catch (error) {
      this.report({state: 'error', label: this.label, saved, error: error.message});
    } finally {
      this.running = false;
      const next = this.next;
      this.next = null;
      if (next) this.run(next);
    }
  }
}
