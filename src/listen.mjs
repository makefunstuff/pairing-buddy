// Push-to-talk for one session: records while the user holds the listen key in Neovim, has whisper.cpp (or OpenRouter)
// write down what they said, asks Pair that, and reads the answer aloud only when they are away from the editor.
// What fails (no microphone, OpenRouter's timeout or error) shows in the editor and in the chat.
import {mkdirSync} from 'node:fs';
import {recorderOf, Recording, speak, speakable, speaks, transcribe, whisperPrompt} from './voice.mjs';

const sentence = text => `${text.replace(/[.\s]+$/, '')}.`;

export class Listener {
  /**
   * `voice` is the config's (see voice.mjs), `dir` where a recording is kept while whisper reads it. `ask(text,
   * selection)` asks Pair and resolves with its words. `transcribeWith` and `speakWith` are for tests.
   */
  constructor({voice, session, dir, recorder = recorderOf(voice), ask, transcribeWith = transcribe, speakWith = speak, log = () => {}}) {
    Object.assign(this, {voice, session, dir, recorder, ask, transcribeWith, speakWith, log});
    mkdirSync(dir, {recursive: true, mode: 0o700});
    this.recording = null; // {recording, send, selection, timer} while the key is held
    this.focused = true; // Neovim has the terminal's focus
    this.silence = null; // stops what is being said aloud
    this.hearing = null; // stops the transcription under way
  }

  /** Neovim gained or lost the terminal's focus. Coming back stops what is being read aloud. */
  focus(on) {
    this.focused = on;
    if (on) this.hush();
  }

  /** Away from the editor: Neovim lost the focus, or herdr shows another workspace. */
  get away() {
    return !this.focused || this.session.state.focus.target === 'elsewhere';
  }

  /**
   * The key went down: records until `stop()`, sending the meter's levels to the editor with `send`. `owner` is the
   * editor's connection, which `drop` names when it goes away.
   */
  start(send, selection = null, owner = null) {
    if (this.recording) this.cancel();
    this.hush();
    if (!this.recorder) return send({type: 'heard', error: 'no recorder found: install pipewire (pw-record), pulseaudio-utils (parec) or alsa-utils (arecord), or set voice.record'});
    const recording = new Recording(this.recorder, {onLevel: level => send({type: 'listening', level})});
    const timer = setTimeout(() => this.stop(), this.voice.maxSeconds * 1000);
    this.recording = {recording, send, selection, timer, owner};
    // A recorder that fails (no microphone, no audio server) says so at once, not when the key is let go.
    recording.closed.then(() => { if (recording.error && this.recording?.recording === recording) this.stop(); });
    send({type: 'listening', level: 0});
  }

  /** The key went up: what was said is written down, shown, and asked. */
  async stop() {
    const current = this.recording;
    if (!current) return;
    this.recording = null;
    clearTimeout(current.timer);
    const {recording, send, selection} = current;
    let text;
    const hearing = new AbortController();
    try {
      const pcm = await recording.stop();
      if (!recording.speech) return send({type: 'heard', text: ''});
      send({type: 'heard', state: 'hearing'});
      const started = Date.now();
      this.hearing = hearing;
      text = await this.transcribeWith(this.voice, pcm, {dir: this.dir, prompt: whisperPrompt(this.session.state), signal: hearing.signal})
        .finally(() => { if (this.hearing === hearing) this.hearing = null; });
      if (hearing.signal.aborted) return; // voice went off meanwhile
      this.log(`heard ${(recording.ms / 1000).toFixed(1)} s of speech in ${Date.now() - started} ms`);
    } catch (error) {
      if (hearing.signal.aborted) return;
      this.log(`listening failed: ${error.message}`);
      this.session.message('system', `Pair could not hear you: ${sentence(error.message)}`);
      return send({type: 'heard', error: error.message});
    }
    send({type: 'heard', text});
    if (!text) return;
    // The answer replaces the heard words under the user's line; '' when Pair only pointed, or nothing came.
    const words = await this.ask(text, selection).catch(error => {
      this.log(`asking what was heard failed: ${error.message}`);
      return '';
    });
    send({type: 'answer', text: words, pointed: Boolean(this.session.target)}); // then the jump key goes there
    if (words && this.away && speaks(this.voice)) {
      this.silence = this.speakWith(this.voice, speakable(words), {
        log: this.log,
        failed: why => this.session.message('system', `Pair could not read its answer aloud: ${sentence(why)}`),
      });
    }
  }

  /** Drops the recording: nothing is written down or asked. */
  cancel() {
    if (!this.recording) return;
    clearTimeout(this.recording.timer);
    this.recording.recording.end();
    this.recording = null;
  }

  /** The editor `owner` went away (Neovim quit or crashed): its recording stops, and nothing is asked. */
  drop(owner) {
    if (this.recording?.owner === owner) this.cancel();
  }

  hush() {
    this.silence?.();
    this.silence = null;
  }

  close() {
    this.cancel();
    this.hearing?.abort();
    this.hush();
  }
}
