// Pair's chat as a pane of the Herdr window: what the terminal's `pair chat` shows (Pair's answers as Markdown, its
// remarks, its questions, the /gen cards, the notes) and what it sends, with buttons where the terminal has keys.
// `pair` in a terminal of the window opens it beside that terminal (src/herdr-panel.mjs), with props
// { cwd, terminal, space, tab, core, session, panel, history?, mod? }: the project, the terminal it was opened from
// (Pair's own pane opens beside it), its space and tab, herdr-core's socket, and the daemon's panel file, which holds
// the loopback port and token this panel connects with (link.js). It tells the daemon where the window's focus is as
// it moves (on each redraw, and from a light timer, since a copy whose tab is hidden is not redrawn), so the daemon does not
// poll `herdr-app status`; and while it is not seen, a new remark or a question of
// Pair's raises a toast that brings it up.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, TextView } from "gpui-base";
import { props, theme, focused, panes, window, notify, readTextFile, settings } from "herdr";
import net from "net";
import { Buffer } from "buffer";
import { ChatModel, confirmChoices, ROLE_NAMES, cardKeys, relayActions, entryText } from "./model.js";
import { COMMANDS, LEVELS } from "./commands.js";
import { openLink } from "./link.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SHOWN = 120; // the newest entries drawn; /clear empties it all
const TYPING_MS = 500;
const FOCUS_MS = 400; // how often a hidden copy looks where the window's focus is
const ROLES = ["navigator", "scout", "driver"];
const DOING = { thinking: "Thinking", tool: "Working", remark: "Writing a remark", waiting: "Waiting for your answer" };

export default class Pair extends View {
  init(_props, cx) {
    this.p = props() ?? {};
    this.mod = this.p.mod ?? "pair";
    this.closed = false;
    this.state = "connecting";
    this.model = new ChatModel({ send: (message) => this.link?.send(message) ?? false });
    this.box = TextareaState.new({ placeholder: "Ask Pair anything · / for commands" });
    this.box.set_auto_grow(1, 8);
    this.box.on("change", (_e, cx) => {
      this.recall = -1;
      this.menuAt = 0;
      const now = Date.now();
      if (this.model.connection === "up" && now - (this.typedAt ?? 0) > TYPING_MS) {
        this.typedAt = now;
        this.link?.send({ type: "event", event: { kind: "typing" } }); // Pair does not speak up while you type
      }
      cx.notify();
    });
    this.box.on("focus", (_e, cx) => { this.boxFocused = true; cx.notify(); });
    this.box.on("blur", (_e, cx) => { this.boxFocused = false; cx.notify(); });
    this.history = [];
    this.recall = -1;
    this.menuAt = 0;
    this.pushed = null; // the focus last told to the daemon
    const hello = (resume) => ({
      type: "hello", role: "chat", cwd: this.p.cwd, resume, panel: true,
      herdr: { kind: "core", socket: this.p.core ?? null, pane: null, beside: this.p.terminal ?? null, space: this.p.space ?? null, tab: this.p.tab ?? null, session: this.p.session ?? null, appHome: null },
    });
    cx.spawn(async (cx) => {
      const file = this.p.panel ?? null;
      if (!file || !this.p.cwd) { this.state = "unset"; cx.notify(); return; }
      this.link = openLink({
        connect: (host, port) => net.connect(host, port),
        readText: (path) => readTextFile(path),
        sleep: (ms) => cx.sleep(ms),
        decode: (bytes) => Buffer.from(bytes).toString("utf8"),
        file, hello,
        closed: () => this.closed,
        onState: (state) => {
          this.state = state;
          if (state === "away") this.model.lost();
          if (state === "down") this.model.connection = "down";
          if (state === "up") this.pushed = null; // the daemon hears where the focus is again
          cx.notify();
        },
        onMessage: (message) => {
          const news = this.model.receive(message, { reconnected: Boolean(message.reconnected) });
          if (message.type === "welcome") { this.loadHistory(message.root, cx); this.pushFocus(); }
          if (news) this.toast(news);
          cx.notify();
        },
        onError: (error, message) => {
          this.model.say(`The panel could not show a ${message?.type ?? "message"}: ${error?.message ?? error}`);
          cx.notify();
        },
      });
      await this.link.done;
    });
    // A copy whose tab is not shown is not drawn again as the focus moves, so the focus is also looked at here: an
    // in-memory read, sent only when it changed, and no redraw.
    cx.timer.every(FOCUS_MS, () => this.pushFocus());
  }

  async close() {
    this.closed = true;
    this.link?.close();
  }

  // The Herdr window.

  /** This panel's pane: the mod pane of its kind in the tab it was opened in. */
  myPane() {
    return panes().find((p) => p.mod === this.mod && p.tab === this.p.tab) ?? null;
  }

  /** Whether the person sees this panel now: the window is active, its tab shown, and no other pane zoomed over it. */
  seen() {
    const mine = this.myPane();
    if (!mine || !window()?.active || focused()?.tab !== mine.tab) return false;
    return !panes().some((p) => p.tab === mine.tab && p.zoomed && p.pane !== mine.pane);
  }

  /** A new remark, or a question of Pair's, while the panel is not seen: a toast that brings it up. */
  toast(news) {
    try { this.raise(news); } catch (error) { this.model.say(`No toast: ${error?.message ?? error}`); }
  }

  raise(news) {
    if (this.seen()) return;
    const pane = this.myPane()?.pane;
    const action = pane ? { name: "pane.focus", args: { pane } } : undefined;
    const first = (text) => String(text ?? "").split("\n").find((line) => line.trim()) ?? "";
    if (news.remark) notify({ title: `Pair · ${news.remark.meta?.trigger ?? "remark"}`, body: first(news.remark.text), level: "info", action });
    if (news.confirm) notify({ title: news.confirm.gen ? `Pair · gen #${news.confirm.gen} asks` : "Pair asks", body: first(news.confirm.text), level: "warning", action });
  }

  /** Tells the daemon where the window's focus is, when it moved: render runs again on every change of it. */
  pushFocus() {
    if (this.state !== "up") return;
    const f = focused();
    const now = { space: f?.space ?? null, tab: f?.tab ?? null, pane: f?.pane ?? null, terminal: f?.terminal ?? null };
    const key = JSON.stringify(now);
    if (key === this.pushed) return;
    if (this.link?.send({ type: "herdr_focus", ...now })) this.pushed = key;
  }

  // What you sent: Up brings it back, as in the terminal's chat (its file too, when `pair` named it).

  loadHistory(root, cx) {
    let own = [];
    try { own = JSON.parse(localStorage.getItem(`history:${root}`) ?? "[]"); } catch {}
    this.history = Array.isArray(own) ? own : [];
    if (!this.p.history) return;
    cx.spawn(async (cx) => {
      try {
        const lines = JSON.parse((await readTextFile(this.p.history)) ?? "{}")?.roots?.[root];
        if (Array.isArray(lines)) this.history = [...lines.filter((line) => typeof line === "string" && !this.history.includes(line)), ...this.history];
      } catch {}
      cx.notify();
    });
  }

  remember(line) {
    this.history = [...this.history.filter((old) => old !== line), line].slice(-200);
    try { localStorage.setItem(`history:${this.model.root}`, JSON.stringify(this.history)); } catch {}
  }

  recallStep(by) {
    const next = this.recall + by;
    if (next < -1 || next >= this.history.length) return false;
    this.recall = next;
    this.box.set_value(next === -1 ? "" : this.history[this.history.length - 1 - next]);
    this.recall = next; // set_value's change put it back to -1
    return true;
  }

  // Typing.

  /** The command menu over the box, while a / command is typed. */
  menu() {
    const text = this.box.value();
    if (!/^\/\S*( [a-z]*)?$/.test(text) || text === this.menuClosed) return [];
    const items = COMMANDS.filter(([name]) => name.startsWith(text.trimEnd()) || (text.endsWith(" ") && name.startsWith(text.trim())));
    return items.length === 1 && items[0][0] === text.trim() && !items[0][1] ? [] : items.slice(0, 8);
  }

  take([name, args], cx) {
    this.menuAt = 0;
    this.box.set_value(args ? `${name} ` : name);
    if (!args) this.enter(cx);
    this.box.focus();
  }

  enter(cx) {
    const line = this.box.value();
    if (!line.trim()) return;
    const done = this.model.submit(line);
    if (done.keep !== undefined) {
      this.box.set_value(done.keep);
      cx.notify();
      return;
    }
    if (done.local === "quit") return;
    if (done.local === "copy" && done.text) { cx.write_to_clipboard(done.text); this.model.say("Copied"); }
    if (this.model.root && !done.local) this.remember(line.trim());
    this.box.set_value("");
    this.recall = -1;
    cx.notify();
  }

  // Drawing.

  render(cx) {
    this.pushFocus();
    const t = theme();
    const m = this.model;
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().id("pair").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(this.header(t, m))
      .child(this.banner(t) ?? div())
      .child(this.log(t, m, mono, cx))
      .child(this.status(t, m))
      .child(this.composer(t, m, cx));
  }

  header(t, m) {
    const h = m.header;
    const role = h.role ?? "navigator";
    const roleColor = { navigator: t.accent, scout: t.done, driver: t.blocked }[role] ?? t.accent;
    const pill = (id, label, active, color, onClick) => div().id(id).px(8).py(2).rounded(10).text_size(11.5).cursor_pointer()
      .border_1().border_color(active ? color : t.border).bg(active ? color + "26" : t.background).text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { onClick(); cx.notify(); }).child(label);
    const dot = (down) => div().size(7).rounded(4).flex_none().bg(down ? t.blocked : t.done);
    const model = (label, name, down) => h_flex().gap(5).items_center().child(dot(down)).child(div().text_color(t.dim).child(label)).child(div().truncate().child(name ?? "…"));
    const index = indexText(m.index);
    return v_flex().flex_none().px(12).pt(9).pb(8).gap(6).border_b_1().border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().text_size(14).child("Pair"))
        .child(div().text_color(t.muted).truncate().child(h.project ?? ""))
        .child(div().flex_1().truncate().text_color(t.dim).child(h.goal ? `· ${h.goal}` : ""))
        .child(h_flex().gap(4).children(ROLES.map((r) => pill(`role-${r}`, `${ROLE_NAMES[r]}${r === "driver" && h.keep && role === "driver" ? " (kept)" : ""}`, role === r, r === role ? roleColor : t.accent, () => m.setRole(r)))))
        .child(pill("level", h.level ?? "…", false, t.accent, () => m.cycleLevel())))
      .child(h_flex().gap(12).items_center().text_size(11.5).text_color(t.muted)
        .child(model("Watcher", m.watcherModel ?? "", Boolean(m.models.watcher)))
        .child(model("Partner", m.model, Boolean(m.models.partner)))
        .when(Boolean(index), (el) => el.child(div().text_color(t.dim).child(index)))
        .when((h.muted ?? []).length > 0, (el) => el.child(div().text_color(t.dim).truncate().child(`muted: ${h.muted.join(", ")}`)))
        .when(Boolean(h.board), (el) => el.child(div().text_color(t.dim).child(`board: ${h.board.working} working${h.board.needs ? `, ${h.board.needs} need you` : ""}`))));
  }

  banner(t) {
    const text = this.state === "unset" ? "This panel was opened without its project: run `pair` in a terminal of the Herdr window."
      : this.state === "down" ? "Pair's daemon is not running. Run `pair` (or `pair setup`) in a terminal; this panel connects once it is up."
        : this.state === "away" ? "Pair's daemon went away; reconnecting… What you type is kept."
          : this.state === "connecting" ? "Connecting to Pair's daemon…" : null;
    if (!text) return null;
    const bad = this.state === "down" || this.state === "unset";
    return h_flex().flex_none().px(12).py(7).gap(8).items_center().bg((bad ? t.blocked : t.working) + "22").border_b_1().border_color(t.border)
      .child(div().size(7).rounded(4).flex_none().bg(bad ? t.blocked : t.working))
      .child(div().flex_1().text_size(12.5).child(text));
  }

  log(t, m, mono, cx) {
    const shown = m.entries.slice(-SHOWN);
    const offset = m.entries.length - shown.length;
    const rows = shown.map((entry, i) => this.entry(t, m, entry, offset + i, mono));
    if (!rows.length && m.connection === "up") rows.push(div().p(16).text_color(t.muted).child("Pair watches your terminals and editors and speaks up when it matters. Ask anything below, or / for commands."));
    // Newest at the bottom, and the scroll starts there.
    return div().id("pair-log").flex_1().min_h(0).overflow_y_scrollbar().flex().flex_col_reverse()
      .child(v_flex().w_full().px(12).py(10).gap(8).children(rows));
  }

  entry(t, m, entry, index, mono) {
    const id = `e${entry.id}`;
    const label = (text, color) => div().text_size(11).font_semibold().text_color(color).child(text);
    const markdown = (text) => TextView.markdown(`${id}-md`, text ?? "").selectable(true);
    switch (entry.kind) {
      case "you":
        return v_flex().gap(2).items_end().child(label("You", t.muted))
          .when(Boolean(entry.aboutText), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`about: ${entry.aboutText}`)))
          .child(div().max_w(560).px(10).py(6).rounded(8).bg(t.raised).child(markdown(entry.text)));
      case "pair":
        return v_flex().gap(2).child(label(entry.partial ? "Pair · writing…" : "Pair", t.accent)).child(markdown(entry.text))
          .when(Boolean(entry.turn), (el) => el.child(div().text_size(11).text_color(t.dim).child(turnText(entry.turn))));
      case "watch":
        return this.remark(t, m, entry, index, markdown);
      case "gen":
        return this.genCard(t, m, entry, markdown);
      case "confirm":
        return this.confirm(t, m, entry, mono);
      case "tool":
        return v_flex().pl(10).children(entry.tools.map(({ tool, what }, i) => div().id(`${id}-t${i}`).text_size(11.5).text_color(t.dim).truncate().child(`└ ${tool} ${what}`)));
      case "error":
        return div().text_size(12.5).text_color(t.blocked).child(markdown(entry.text));
      case "note":
        return this.note(t, m, entry, mono);
      default:
        return div().text_size(12.5).text_color(t.muted).child(markdown(entry.text));
    }
  }

  button(id, text, t, onClick, { primary = false, color = null, disabled = false } = {}) {
    const ink = color ?? t.accent;
    return div().id(id).px(10).py(3).rounded(6).text_size(12).border_1().flex_none()
      .border_color(primary ? ink : t.input).bg(primary ? ink : t.background).text_color(primary ? t.accent_foreground : disabled ? t.dim : t.foreground)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => { onClick(cx); cx.stop_propagation(); cx.notify(); }))
      .child(text);
  }

  /** A remark: its words, and on its last entry its buttons: Useful, Noise, Dismiss, and Accept or Jump where it has them. */
  remark(t, m, entry, index, markdown) {
    const id = `e${entry.id}`;
    const group = m.remarkGroup(entry.meta.remark);
    const last = group.at(-1) === entry;
    const first = group[0] === entry;
    const verdict = entry.verdict;
    if (entry.dismissed) {
      return first ? div().text_size(11.5).text_color(t.dim).truncate().child(`Remark dismissed · ${String(entry.text ?? "").split("\n")[0]}`) : div();
    }
    const keys = m.remarkKeys(index);
    const card = v_flex().gap(6).px(10).py(8).rounded(8).border_1().border_color(t.working + "88").bg(t.working + "12")
      .when(first, (el) => el.child(h_flex().gap(6).items_center()
        .child(div().size(7).rounded(4).bg(t.working))
        .child(div().text_size(11).font_semibold().text_color(t.working).child(`Remark · ${entry.meta.trigger ?? ""}`))
        .when(Boolean(verdict), (el) => el.child(div().text_size(11).text_color(t.muted).child(verdict === "useful" ? "· useful" : "· noise")))))
      .child(markdown(entry.text))
      .when(Boolean(entry.applied), (el) => el.child(div().text_size(11.5).text_color(t.done).child("Taken in Neovim")));
    if (!last) return card;
    return card.child(h_flex().gap(6).flex_wrap()
      .when(Boolean(keys.apply), (el) => el.child(this.button(`${id}-accept`, "Accept", t, () => m.accept(keys.apply), { primary: true })))
      .when(Boolean(keys.jump), (el) => el.child(this.button(`${id}-jump`, "Jump", t, () => m.jump(keys.jump))))
      .child(this.button(`${id}-useful`, verdict === "useful" ? "Useful ✓" : "Useful", t, () => m.rate(entry, true), { primary: verdict === "useful", color: t.done }))
      .child(this.button(`${id}-noise`, verdict === "noise" ? "Noise ✓" : "Noise", t, () => m.rate(entry, false), { primary: verdict === "noise", color: t.blocked }))
      .child(this.button(`${id}-dismiss`, "Dismiss", t, () => m.dismiss(entry)))
      .child(this.button(`${id}-why`, "Why?", t, () => m.explain(entry)))
      .child(this.button(`${id}-follow`, "Follow up", t, () => { m.followUp(entry); this.box.focus(); }))
      .child(this.button(`${id}-mute`, "Mute kind", t, () => m.mute(entry))));
  }

  /** Pair's question: its words, the command it is about, and its answers as buttons; once answered, what you said. */
  confirm(t, m, entry, mono) {
    const id = `e${entry.id}`;
    const open = entry.answer === undefined && entry.confirm === m.confirming;
    const { choices } = confirmChoices(entry);
    const answered = entry.answer === true ? "Yes" : entry.answer === false ? (entry.confirm === m.confirming ? "" : "No") : entry.answer ? String(entry.answer) : "";
    return v_flex().gap(6).px(10).py(8).rounded(8).border_1().border_color(open ? t.accent : t.border).bg(open ? t.accent + "14" : t.surface)
      .child(div().text_size(11).font_semibold().text_color(entry.gen ? t.ansi5 ?? t.accent : t.accent).child(entry.gen ? `gen #${entry.gen} asks` : "Pair asks"))
      .child(TextView.markdown(`${id}-md`, entry.text ?? "").selectable(true))
      .when(Boolean(entry.command), (el) => el.child(div().px(8).py(6).rounded(6).bg(t.raised).font_family(mono).text_size(12).child(entry.command)))
      .when(open, (el) => el.child(h_flex().gap(6).flex_wrap().children(choices.map((choice, i) => this.button(`${id}-c${i}`, choice.label, t, (cx) => {
        if (choice.key === "c" && entry.copy && entry.command) cx.write_to_clipboard(entry.command);
        m.answer(entry, { text: choice.text });
      }, { primary: i === 0 })))))
      .when(!open && Boolean(answered), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(`Answered: ${answered}`)))
      .when(!open && entry.answer === false && !answered, (el) => el.child(div().text_size(11.5).text_color(t.muted).child("No answer")));
  }

  /** What a /gen request made, with its card's buttons: keep, open, drop what is left, undo. */
  genCard(t, m, entry, markdown) {
    const id = `e${entry.id}`;
    const keys = cardKeys(entry.card);
    const words = { k: "Keep", enter: "Open", d: "Drop rest", u: "Undo" };
    return v_flex().gap(6).px(10).py(8).rounded(8).border_1().border_color((t.ansi5 ?? t.accent) + "88").bg((t.ansi5 ?? t.accent) + "10")
      .child(div().text_size(11).font_semibold().text_color(t.ansi5 ?? t.accent).child(entry.card ? `gen #${entry.card.gen} · ${entry.card.shape} · ${entry.card.state}` : "gen"))
      .child(markdown([entry.text, entry.meta?.hint].filter(Boolean).join("\n\n")))
      .when(keys.length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().children(keys.map(([key, , what]) =>
        this.button(`${id}-${key}`, `${words[key] ?? key}${what ? ` · ${what}` : ""}`, t, (cx) => {
          const done = m.cardAct(entry, key);
          if (done?.keep !== undefined) { this.box.set_value(done.keep); this.box.focus(); }
        })))));
  }

  /** A note (the ledger, /remarks, /agents, /find, the help): its lines as they are, and a relayed line's buttons. */
  note(t, m, entry, mono) {
    const id = `e${entry.id}`;
    const actions = relayActions(entry);
    const words = { o: "Open", d: "Diff", t: "Terminal" };
    return v_flex().gap(4).px(8).py(6).rounded(6).bg(t.surface).text_size(12).text_color(t.muted)
      .child(v_flex().font_family(mono).children(String(entry.text ?? "").split("\n").map((line, i) => div().id(`${id}-l${i}`).child(line || " "))))
      .when(actions.length > 0, (el) => el.child(h_flex().gap(6).children(actions.map(([key]) => this.button(`${id}-${key}`, words[key], t, () => m.relayAct(entry, key))))));
  }

  status(t, m) {
    const a = m.activity ?? { state: "idle" };
    const gen = m.gen;
    const parts = [];
    if (a.state === "tool") parts.push(`${a.tool ?? "working"} ${String(a.what ?? "").split("\n")[0]}`);
    else if (a.state && a.state !== "idle") parts.push(`${DOING[a.state] ?? a.state}${a.what ? `: ${String(a.what).split("\n")[0]}` : ""}`);
    if (gen.running) parts.push(`gen #${gen.running.gen} ${gen.running.state}`);
    if (gen.queued.length) parts.push(`${gen.queued.length} waiting`);
    if (gen.ready) parts.push(`gen #${gen.ready.gen}: ${gen.ready.text}`);
    if (m.held.length) parts.push(`${m.held.length} below once the answer is done`);
    const working = m.busy || a.state === "remark" || (gen.running && gen.running.state !== "asks");
    const flash = m.flash && Date.now() - m.flash.at < 4000 ? m.flash.text : null;
    if (!parts.length && !flash && !m.about) return div();
    return h_flex().flex_none().px(12).py(4).gap(8).items_center().text_size(12).text_color(t.muted).border_t_1().border_color(t.border)
      .when(Boolean(working), (el) => el.child(div().text_color(t.accent).frames(SPINNER, 90)))
      .child(div().flex_1().truncate().child(flash ?? parts.join(" · ") ?? ""))
      .when(Boolean(m.about), (el) => el.child(div().truncate().text_color(t.dim).child(`about: ${m.about.text}`)));
  }

  composer(t, m, cx) {
    const items = this.boxFocused ? this.menu() : [];
    const at = Math.min(this.menuAt, Math.max(0, items.length - 1));
    const stoppable = m.busy || m.activity.state === "remark" || m.genAtWork || m.confirming !== null;
    this.box.set_placeholder?.(m.placeholder());
    return v_flex().flex_none().px(10).pt(6).pb(10).gap(6)
      .when(items.length > 0, (el) => el.child(v_flex().rounded(8).border_1().border_color(t.border).bg(t.popover).py(4)
        .children(items.map((item, i) => h_flex().id(`menu-${i}`).px(10).py(3).gap(10).cursor_pointer().bg(i === at ? t.selected : t.popover)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.take(item, cx))
          .child(div().font_semibold().child(`${item[0]}${item[1] ? ` ${item[1]}` : ""}`))
          .child(div().flex_1().truncate().text_color(t.muted).child(item[2]))))))
      .child(h_flex().gap(8).items_end()
        .child(div().id("pair-box").flex_1().rounded(8).border_1().border_color(this.boxFocused ? t.accent : t.input).bg(t.surface).px(8).py(4)
          .on_key_down((e, cx) => {
            const k = e.key;
            const mods = e.modifiers ?? {};
            if (items.length) {
              if (k === "up" || k === "down") { this.menuAt = (at + (k === "down" ? 1 : items.length - 1)) % items.length; cx.stop_propagation(); cx.notify(); return; }
              if (k === "tab" || (k === "enter" && !mods.shift)) { cx.stop_propagation(); this.take(items[at], cx); cx.notify(); return; }
              if (k === "escape") { this.menuClosed = this.box.value(); cx.stop_propagation(); cx.notify(); return; }
            }
            if ((k === "up" && (!this.box.value() || this.recall >= 0)) || (k === "down" && this.recall >= 0)) {
              if (this.recallStep(k === "up" ? 1 : -1)) { cx.stop_propagation(); cx.notify(); }
              return;
            }
            if (k === "escape") { cx.stop_propagation(); if (m.about) m.about = null; else m.stop(); cx.notify(); return; }
            if (k === "enter" && !mods.shift && !mods.alt) { cx.stop_propagation(); this.enter(cx); }
          })
          .child(Textarea.new(this.box)))
        .child(stoppable
          ? this.button("pair-stop", m.confirming !== null ? "No" : "Stop", t, () => m.stop())
          : this.button("pair-send", "Send", t, (cx) => this.enter(cx), { primary: true })));
  }
}

/** How far search by meaning's index of the project is, for the header: "index 42%", or null when there is nothing to say. */
export function indexText(index) {
  if (!index) return null;
  if (index.phase === "done") return "index ready";
  if (index.phase === "failed") return "index failed";
  if (index.total > 0) return `index ${Math.floor((100 * (index.done ?? 0)) / index.total)}%`;
  return index.phase ? `index ${index.phase}` : null;
}

/** What an answer took: 3s · 1.2k tokens. */
function turnText({ ms, tokens }) {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  const time = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  const total = typeof tokens === "number" ? tokens : (tokens?.input ?? 0) + (tokens?.output ?? 0);
  return total ? `${time} · ${total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total} tokens` : time;
}

export { LEVELS };
