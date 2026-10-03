# polyglot-dev

A builder on OpenCode and an independent reviewer on Gemini CLI, so the code and its review come from different model families.

| Seat | Runtime | Agent |
|---|---|---|
| `dev.builder` | `opencode` | development/implementer |
| `dev.reviewer` | `gemini` | review/independent-reviewer |

## Before `rig up`

- **opencode** on `PATH` (`brew install anomalyco/tap/opencode`, or `npm i -g opencode-ai`). Sign in with `opencode auth login` or set a provider key such as `ANTHROPIC_API_KEY`. Without either, OpenCode uses its free OpenCode Zen models.
- **gemini** on `PATH` (`npm install -g @google/gemini-cli`) with `GEMINI_API_KEY` set, or Vertex AI credentials. "Sign in with Google" no longer works for personal accounts.
- **gemini auth method chosen once.** A key alone is not enough: until `security.auth.selectedType` is set in `~/.gemini/settings.json`, every launch opens Gemini's auth dialog and the reviewer seat stops at `login_required`. Run `gemini` once and pick "Use Gemini API Key" (or Vertex AI), or set it directly, for example `{ "security": { "auth": { "selectedType": "gemini-api-key" } } }`. OpenRig never writes it. See `docs/reference/runtimes/gemini.md`.

Provider keys must be in the environment the OpenRig daemon starts seats from. If a CLI is missing, `rig up` refuses in preflight and names the install command; if a CLI is installed but not signed in, that seat stops at `attention_required` with the reason.

Neither seat sets `model:`, so each CLI uses its configured default. Set `model:` per member to choose (`provider/model` for OpenCode).
