// The fake Python of fake-python.mjs, run by its wrapper: node fake-python-run.mjs OPTIONS.json ARGS...
// Not through fake-python.mjs, which the tests' temp folders come with: this runs outside them.
import {chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

/** The venv's own `bin/python`: this fake again, knowing its venv. */
function venvPython(home, options) {
  writeFileSync(join(home, 'bin', 'python.json'), JSON.stringify({...options, home}));
  writeFileSync(join(home, 'bin', 'python'), `#!/bin/sh\nexec "${process.execPath}" "${process.argv[1]}" "${join(home, 'bin', 'python.json')}" "$@"\n`);
  chmodSync(join(home, 'bin', 'python'), 0o755);
}

const [optionsPath, ...args] = process.argv.slice(2);
const options = JSON.parse(readFileSync(optionsPath, 'utf8'));
const {version = '3.12', venv: hasVenv = true} = options;
const rest = args[0] === '-I' ? args.slice(1) : args;
if (rest[0] === '-c' && rest[1].includes('ensurepip')) {
  process.stdout.write(`${version}\n${hasVenv ? 'venv' : 'no venv'}\n`);
} else if (rest[0] === '-c' && rest[1].includes('litert_lm')) {
  if (options.home && existsSync(join(options.home, 'installed'))) process.stdout.write('0.19.0\n');
  else {
    process.stderr.write("ModuleNotFoundError: No module named 'litert_lm'\n");
    process.exitCode = 1;
  }
} else if (rest[0] === '-m' && rest[1] === 'venv') {
  const home = rest[2];
  mkdirSync(join(home, 'bin'), {recursive: true});
  writeFileSync(join(home, 'pyvenv.cfg'), `version = ${version}\n`);
  venvPython(home, options);
} else if (rest[0] === '-m' && rest[1] === 'pip' && rest[2] === 'install') {
  const links = rest[rest.indexOf('--find-links') + 1];
  writeFileSync(join(options.home, 'pip.json'), JSON.stringify({args: rest.slice(3), lock: readFileSync(rest.at(-1), 'utf8'), wheels: readdirSync(links), noInput: process.env.PIP_NO_INPUT}));
  if (options.pipHangs) setInterval(() => {}, 1000);
  else if (options.pipError) {
    process.stderr.write(`Collecting litert-lm-api==0.19.0\n${options.pipError}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Processing ./litert_lm_api-0.19.0-py3-none-manylinux_2_27_x86_64.whl\n');
    writeFileSync(join(options.home, 'installed'), '');
    process.stdout.write('Successfully installed litert-lm-api-0.19.0\n');
  }
} else {
  process.stderr.write(`fake python: ${args.join(' ')}?\n`);
  process.exitCode = 2;
}
