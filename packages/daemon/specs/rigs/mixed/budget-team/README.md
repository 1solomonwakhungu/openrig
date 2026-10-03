# budget-team

A no-cost starting point: a builder on OpenCode and a checker on Kilo CLI.

> **Privacy: do not use this template on private or sensitive code without signing in.** With no credentials, both seats send their prompts, OpenRig's startup and context messages, and any repository content they read to the OpenCode Zen and Kilo Gateway free models, anonymously, under those providers' terms, with no account of your own. To keep your code with a provider you choose, sign in or set a provider key (see below).

| Seat | Runtime | Agent |
|---|---|---|
| `dev.builder` | `opencode` | development/implementer |
| `dev.checker` | `kilo` | development/qa |

## Before `rig up`

- **opencode** on `PATH` (`brew install anomalyco/tap/opencode`, or `npm i -g opencode-ai`).
- **kilo** on `PATH` (`npm i -g @kilocode/cli`).

No sign-in is required to start. Without credentials, OpenCode uses its free OpenCode Zen models and Kilo uses its free "Auto Free" model on Kilo Gateway; both seats reach `ready` that way. Free models have provider rate limits and can change. For stronger models, sign in (`opencode auth login`, `kilo auth login`) or set a provider key such as `ANTHROPIC_API_KEY`, and set `model:` (`provider/model`) per member.

If a CLI is missing, `rig up` refuses in preflight and names the install command; if a CLI is installed but not signed in, that seat stops at `attention_required` with the reason.
