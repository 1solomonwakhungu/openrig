# budget-team

A no-cost starting point: a builder on OpenCode and a checker on Kilo CLI.

| Seat | Runtime | Agent |
|---|---|---|
| `dev.builder` | `opencode` | development/implementer |
| `dev.checker` | `kilo` | development/qa |

## Before `rig up`

- **opencode** on `PATH` (`brew install anomalyco/tap/opencode`, or `npm i -g opencode-ai`).
- **kilo** on `PATH` (`npm i -g @kilocode/cli`).

No sign-in is required. Without credentials, OpenCode uses its free OpenCode Zen models and Kilo uses its free "Auto Free" model on Kilo Gateway; both seats reach `ready` that way. Free models have provider rate limits and can change. For stronger models, sign in (`opencode auth login`, `kilo auth login`) or set a provider key such as `ANTHROPIC_API_KEY`, and set `model:` (`provider/model`) per member.

Note that OpenRig's startup message is delivered to each seat on launch, so with no credentials it is processed by those free models.
