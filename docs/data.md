# Data and privacy

- **Logins and keys** live in `auth.json` next to the config, readable by you only
  ([config.md](config.md#logins-and-keys)).
- **Everything else** lives in the data directory: `~/.local/state/pairing-buddy` by default, or under
  `$XDG_STATE_HOME`, or `dataDir` in the config.

| File | What it holds |
| --- | --- |
| `partner.sqlite` | The Partner's conversations, one per project (pi-durable) |
| `sessions.sqlite` | Sessions, goals, chat history, session notes, active time, and the remarks with your verdicts |
| `runs/` | The output of the latest [tests on save](tests-on-save.md) run of each session |
| `daemon.log` | The daemon's log, when `pair` started it (under systemd it goes to the journal) |
| `daemon.lock` | Makes sure one daemon owns the files above |

Nothing is written to your repository. Nothing leaves your machine except the requests to the model endpoints you
configured and, for a login, to the provider's sign-in service.
