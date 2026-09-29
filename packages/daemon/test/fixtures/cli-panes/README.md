# CLI pane fixtures

Pane captures used by the hermetic runtime adapter tests. Home paths are
replaced with `/home/user/work`.

| File | Source |
|---|---|
| `copilot-first-run.txt` | Live: Copilot CLI 1.0.89, untrusted folder, unauthenticated |
| `copilot-after-trust.txt` | Live: same pane after answering the trust modal |
| `copilot-idle-unauth.txt` | Live: pre-trusted folder via `trustedFolders`, unauthenticated |
| `copilot-idle-derived.txt` | Derived: `copilot-idle-unauth.txt` without the unauthenticated lines |
| `copilot-after-login-derived.txt` | Derived: `copilot-idle-unauth.txt` with a line printed after the sign-in prompt (the post-`/login` wording is illustrative, not captured) |
| `cursor-first-run.txt` | Live: Cursor CLI 2026.09.28-64d2043, unauthenticated |
| `cursor-idle-synth.txt`, `cursor-followup-synth.txt`, `cursor-trust-synth.txt` | Synthesized from strings in the Cursor CLI bundle; layout is illustrative, not captured |

80x24 fixtures (the daemon's pane size), with a long cwd so paths wrap or are
shortened as they are at that width. Live ones replace the home user name with
a same-length placeholder so wrapping is unchanged.

| File | Source |
|---|---|
| `copilot-80-trust.txt` | Live: trust dialog, long cwd hard-wrapped inside the box |
| `copilot-80-idle-unauth.txt` | Live: pre-trusted long cwd (shown shortened with `...`), unauthenticated |
| `copilot-80-idle-derived.txt` | Derived: `copilot-80-idle-unauth.txt` without the unauthenticated lines |
| `copilot-80-after-login-derived.txt` | Derived: `copilot-80-idle-unauth.txt` with a line printed after the sign-in prompt (wording illustrative) |
| `copilot-80-resume-missing.txt` | Live: `--resume=<unknown id>` error, then the shell |
| `cursor-80-login.txt` | Live: unauthenticated start |
| `cursor-80-idle-synth.txt`, `cursor-80-followup-synth.txt`, `cursor-80-resumed-synth.txt`, `cursor-80-trust-synth.txt` | Synthesized from bundle strings at 80 columns; layout illustrative |
