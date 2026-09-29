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
