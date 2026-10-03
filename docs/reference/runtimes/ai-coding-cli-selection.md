# AI coding CLI selection for native runtime adapters

This page records why the ten CLIs below were selected as targets for native OpenRig runtime
adapters, in addition to the existing Claude Code, Codex, and Pi adapters. It is a point-in-time
ranking, not a product endorsement, and selection does not by itself mean an adapter is available:
check the supported runtime list in [rig-spec.md](../rig-spec.md) for what your installed version
provides.

- Retrieved: 2026-09-29. Download windows are the most recent month each registry reports (30 days for npm and Homebrew, 31 days for pypistats, ending 2026-09-27 or 2026-09-28) unless noted.
- Scope: interactive AI coding agents that run in a terminal and can be driven inside a tmux pane.
- Excluded by definition: Claude Code, OpenAI Codex CLI, and Pi (already supported natively).
- Measured values come from public registries (npm, PyPI, Homebrew analytics, GitHub). Values
  marked `~` are estimates, and vendor user counts are claims, labelled as such.

## Ranking

| # | CLI | Binary | Composite | Monthly installs (measured unless ~) | Homebrew 30d | GitHub stars | Status note |
|---|-----|--------|-----------|------|------|------|------|
| 1 | OpenCode | `opencode` | 1.000 | 9,101,061 | 17,952 | 210,809 | Active; vendor claims 16M monthly devs |
| 2 | GitHub Copilot CLI | `copilot` | 0.814 | 9,020,225 | 8,509 | 11,223 (issue repo, closed source) | Active |
| 3 | Gemini CLI | `gemini` | 0.802 | 1,530,255 | 2,952 | 107,186 | Consumer logins shut off 2026-06-18; API key and enterprise only; Homebrew formula deprecated |
| 4 | Cursor CLI | `agent` (alias `cursor-agent`) | 0.589 | ~359,384 (imputed: Homebrew 701 x 512.7) | 701 | n/a (closed) | Active; curl installer only |
| 5 | Kilo CLI | `kilo` | 0.571 | 142,651 | n/a (no core formula) | 27,442 | Active; now an OpenCode fork |
| 6 | Cline CLI | `cline` | 0.561 | 284,713 | 71 | 69,555 (shared with extension) | Active; CLI 3.x |
| 7 | Antigravity CLI | `agy` | 0.558 | 220,688 (217,157 GitHub release asset downloads + 3,531 Homebrew cask; release count includes self-updates) | 3,531 | 2,417 | Active; Google's successor to Gemini CLI |
| 8 | Qwen Code | `qwen` | 0.555 | 264,669 | 2,332 | 28,222 | Active; Gemini CLI fork |
| 9 | Aider | `aider` | 0.549 | 267,807 | 286 | 49,276 | Slowing; last push 2026-05-22 |
| 10 | Grok Build | `grok` | 0.509 | 257,943 | 519 | 27,152 | Active; v1.0.44; SuperGrok / X Premium+ subscription or XAI_API_KEY |

Runners-up (11 to 22): Goose 0.481, Kiro CLI 0.480, Kimi Code 0.458, Crush 0.452, Open Interpreter 0.413, Mistral Vibe 0.370, Muse Code 0.361, Continue CLI 0.354, Factory Droid 0.335, Amp 0.327, Auggie 0.295, Junie CLI 0.019.

Positions 8 to 13 are separated by less than 0.10 and should be read as a tier, not a strict order. The top 3 are clearly separated from everything else.

## Methodology

Four signals, each log10-scaled and min-max normalized across the 22 evaluated candidates:

| Signal | Weight | Kind | Notes |
|---|---|---|---|
| D: package-manager installs, 30d, all measurable channels summed | 0.45 | Measured | npm last-month + PyPI last_month + Homebrew 30d + GitHub release CLI-asset downloads for releases published in window |
| H: Homebrew 30d installs | 0.20 | Measured | The one channel nearly every candidate shares, including curl-installer tools; macOS-skewed |
| S: GitHub stars | 0.20 | Measured | Measures attention more than use; for tools whose repo is shared with an IDE extension this overstates CLI use |
| V: vendor-claimed users | 0.15 | Vendor claim | Bucketed: 1.0 CLI-specific claim >= 10M; 0.75 CLI-specific claim of "millions"; 0.5 parent-platform claim of millions; 0.25 weak or stale claim; 0 none found |

Missing signals (closed source so no stars, no homebrew-core formula) are treated as missing, and the remaining weights are renormalized, rather than scored as zero.

Estimated values: for three curl-installer tools with no package-registry footprint (Cursor CLI, Kiro CLI, Muse Code), D is imputed as Homebrew 30d x 512.7, the median D/H ratio over the 12 tools that have both a measured D and a Homebrew count (Grok Build is held out because it served as the validation case). This gives Cursor CLI ~359,384, Kiro CLI ~366,048, and Muse Code ~90,743; these rows are marked "~". Validation: before its npm package (`@xai-official/grok`) was found, Grok Build was imputed at ~263,000; the measured D is 257,943, within 2%. Even so, this is the weakest part of the ranking, and Cursor CLI in particular could plausibly sit anywhere from #4 to #12.

Known biases in measured data:
- npm counts include CI, Docker builds, and auto-update pulls. OpenCode and Copilot CLI both self-update, which inflates them relative to tools that are installed once. Platform-specific optional dependencies are separate packages and are not double counted in the top-level package number.
- Mistral Vibe's PyPI count (5,292,621/month) is 97% Linux (5,156,715) with only 14,902 macOS+Windows downloads, which looks like CI or image-build traffic. It was adjusted to 69,643 by dividing its macOS+Windows downloads by Aider's macOS+Windows share, both taken from the same pypistats `/system` endpoint and window (Aider: 59,165 of 276,502 = 21.40%). Adding the Homebrew formula's 230 gives D = 69,873. Raw number reported for transparency.
- Antigravity CLI's GitHub release count covers 20 releases in 30 days and includes the self-updater, so it overstates new installs.
- Homebrew analytics are opt-out and macOS-heavy; they undercount Linux and Windows users.

Applying the method above to the "Scoring inputs" table below reproduces every score to within 0.001.

## Scoring inputs

D = 30-day installs summed across measurable channels ("~" = imputed); H = Homebrew 30d; S = GitHub stars; V = vendor-claim bucket. "n/a" = signal absent, weight renormalized.

| # | CLI | Score | D | H | S | V |
|---|---|---|---|---|---|---|
| 1 | OpenCode | 1.000 | 9,101,061 | 17,952 | 210,809 | 1.0 |
| 2 | GitHub Copilot CLI | 0.814 | 9,020,225 | 8,509 | 11,223 | 0.5 |
| 3 | Gemini CLI | 0.802 | 1,530,255 | 2,952 | 107,186 | 0.75 |
| 4 | Cursor CLI | 0.589 | ~359,384 | 701 | n/a | 0.5 |
| 5 | Kilo CLI | 0.571 | 142,651 | n/a | 27,442 | 0.5 |
| 6 | Cline CLI | 0.561 | 284,713 | 71 | 69,555 | 0.5 |
| 7 | Antigravity CLI | 0.558 | 220,688 | 3,531 | 2,417 | 0.5 |
| 8 | Qwen Code | 0.555 | 264,669 | 2,332 | 28,222 | 0.0 |
| 9 | Aider | 0.549 | 267,807 | 286 | 49,276 | 0.25 |
| 10 | Grok Build | 0.509 | 257,943 | 519 | 27,152 | 0.0 |
| 11 | Goose | 0.481 | 60,454 | 1,156 | 54,772 | 0.0 |
| 12 | Kiro CLI | 0.480 | ~366,048 | 714 | 4,340 | 0.0 |
| 13 | Kimi Code | 0.458 | 154,794 | 793 | 7,736 | 0.0 |
| 14 | Crush | 0.452 | 93,561 | n/a | 28,361 | 0.0 |
| 15 | Open Interpreter | 0.413 | 29,140 | n/a | 68,474 | 0.0 |
| 16 | Mistral Vibe | 0.370 | 69,873 | 230 | 5,018 | 0.0 |
| 17 | Muse Code | 0.361 | ~90,743 | 177 | n/a | 0.0 |
| 18 | Continue CLI | 0.354 | 16,709 | n/a | 36,062 | 0.0 |
| 19 | Factory Droid | 0.335 | 82,269 | 102 | n/a | 0.0 |
| 20 | Amp | 0.327 | 204,129 | 16 | n/a | 0.0 |
| 21 | Auggie | 0.295 | 123,463 | n/a | 283 | 0.0 |
| 22 | Junie CLI | 0.019 | 1,063 | n/a | 464 | 0.0 |

## Raw measured data (retrieved 2026-09-29)

| CLI | Package / source | Monthly downloads | Weekly | Homebrew 30d / 90d | Stars (repo) | Vendor claim |
|---|---|---|---|---|---|---|
| OpenCode | npm `opencode-ai` | 9,083,109 | 2,720,485 | formula `opencode` 17,952 / 89,444; cask `opencode-desktop` 4,117 / 22,393 (desktop app, excluded) | 210,809 (anomalyco/opencode) | "16M monthly devs" on opencode.ai (vendor); 4.6M WAU / 13M MAU (Jay V on Lightcone, July 2026, vendor); 301,018 paid Go subscribers (Aug 2026, vendor) |
| GitHub Copilot CLI | npm `@github/copilot` | 9,011,716 | 1,447,527 | cask `copilot-cli` 8,509 / 45,282 | 11,223 (github/copilot-cli, issue tracker) | No CLI-specific public count found; Copilot overall is widely reported at tens of millions of users (parent platform; not re-verified in this pass) |
| Gemini CLI | npm `@google/gemini-cli` | 1,527,303 | 432,823 | formula `gemini-cli` 2,952 / 24,204 (deprecated, disable date 2026-12-18) | 107,186 | "community of millions of users" (Google Developers Blog, 2026-05-19) |
| Cline CLI | npm `cline` | 284,642 | 86,289 | formula `cline` 71 / 263 | 69,555 (cline/cline, shared with VS Code extension) | 5M+ installs (extension, parent platform) |
| Aider | PyPI `aider-chat` | 267,521 (desktop OS: 59,165) | 57,740 | formula `aider` 286 / 1,799 | 49,276 | "15B tokens/week" on aider.chat (stale page) |
| Qwen Code | npm `@qwen-code/qwen-code` | 262,337 | 80,114 | formula `qwen-code` 2,332 / 14,018 | 28,222 | None found |
| Antigravity CLI | GitHub releases google-antigravity/antigravity-cli (curl installer) | 217,157 asset downloads, 20 releases | n/a | cask `antigravity-cli` 3,531 / 19,163 | 2,417 | "millions of developers" building on Antigravity platform (Google, I/O 2026, parent platform) |
| Amp | npm `@ampcode/cli` + legacy `@sourcegraph/amp` | 121,660 + 82,453 = 204,113 | 38,198 + 23,529 | formula `amp` 16 / 96 | closed source | None found |
| Kimi Code | npm `@moonshot-ai/kimi-code` | 154,001 | 35,807 | formula `kimi-code` 793 / 5,959 | 7,736 (MoonshotAI/kimi-code) | None found. Legacy Python `kimi-cli` (PyPI 46,205/month) repo archived, replaced by Kimi Code |
| Kilo CLI | npm `@kilocode/cli` | 142,651 | 48,527 | none in homebrew-core | 27,442 (Kilo-Org/kilocode) | "1.5M+ Kilo Coders" (repo description, platform-wide); 1,554,215 VS Code installs |
| Auggie | npm `@augmentcode/auggie` | 123,463 | 36,512 | none | 283 (augmentcode/auggie, docs/issues repo) | None found |
| Crush | npm `@charmland/crush` + GitHub release assets | 27,060 + 66,501 = 93,561 | 8,692 (npm) | only in charmbracelet tap (no analytics) | 28,361 | None found |
| Factory Droid | npm `droid` + `@factory/cli` | 44,726 + 37,441 = 82,167 | 10,461 + 10,060 | cask `droid` 102 / 615 | closed (Factory-AI/factory has 37) | None found |
| Mistral Vibe | PyPI `mistral-vibe` | 5,292,621 raw; 69,643 adjusted (D with Homebrew: 69,873) | 678,917 raw | formula `mistral-vibe` 230 / 3,435 | 5,018 | None found |
| Goose | GitHub release CLI assets aaif-goose/goose (repo moved from block/goose) | 59,298 | n/a | formula `block-goose-cli` 1,156 / 5,835 | 54,772 | None found |
| Open Interpreter | PyPI `open-interpreter` | 29,140 | 6,074 | none | 68,474 | None found |
| Continue CLI | npm `@continuedev/cli` (`cn`) | 16,709 | 5,931 | none | 36,062 (shared with extension) | None found |
| Cursor CLI | curl installer only | not measurable | n/a | cask `cursor-cli` 701 / 3,939 | closed | Cursor platform has millions of users (parent platform) |
| Kiro CLI | curl installer | not measurable | n/a | cask `kiro-cli` 714 / 4,020 | 4,340 (kirodotdev/Kiro, shared with IDE) | None CLI-specific |
| Grok Build | npm `@xai-official/grok` (curl installer is primary) | 257,424 | 64,668 | cask `grok-build` 519 / 3,712 | 27,152 (xai-org/grok-build, open-sourced 2026-07-15) | "No verified user numbers published" (Ry Walker Research, Aug 2026) |
| Muse Code (Meta) | curl installer | not measurable (SDK `@muse-code/sdk` 22,260) | n/a | cask `muse-code` 177 / 253 | closed | None; out of beta 2026-08-31 |
| Junie CLI | npm `@jetbrains/junie-cli` | 1,063 | 273 | none | 464 | None found |
| iFlow CLI | npm `@iflow-ai/iflow-cli` | 1,858 | 527 | none | 5,090 | Not scored (too small) |
| Grok CLI (community, superagent-ai) | npm `@vibe-kit/grok-cli` | 3,916 | 978 | none | 3,484 | Not scored (superseded by official Grok Build) |

Reference points (excluded from ranking): `@openai/codex` 86,107,464/month; `@anthropic-ai/claude-code` 52,781,541/month; `@mariozechner/pi-coding-agent` 3,244,207/month; Homebrew cask `codex` 86,276/30d, `claude-code` 29,505/30d.

Sources for measured data:
- npm: `https://api.npmjs.org/downloads/point/last-month/<pkg>` and `/last-week/<pkg>`
- PyPI: `https://pypistats.org/api/packages/<pkg>/recent` and `/system` for OS split
- Homebrew: `https://formulae.brew.sh/api/formula/<name>.json`, `https://formulae.brew.sh/api/cask/<token>.json`
- GitHub: `gh api repos/<owner>/<repo>` (stargazers_count) and `gh api repos/<owner>/<repo>/releases` (asset download_count)

Sources for vendor claims and status:
- OpenCode 16M monthly devs: https://opencode.ai/ ; 13M MAU and $40M ARR: https://www.seventnews.com/en/articles/opencode-hit-40m-arr-by-betting-developers-want-choices-not-lock-in ; 301k Go subscribers: https://runtimewire.com/article/opencode-go-301000-active-subscribers
- Gemini CLI to Antigravity CLI transition: https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ ; shutdown notice: https://github.com/google-gemini/gemini-cli/discussions/28017 ; deprecation table: https://developers.google.com/gemini-code-assist/docs/deprecations ; Homebrew deprecation dispute: https://github.com/Homebrew/homebrew-core/issues/289444
- Antigravity platform claim: https://thenewstack.io/google-io-antigravity-codemender-ai-agentic/ ; https://blog.google/innovation-and-ai/technology/developers-tools/google-io-2026-developer-highlights/
- Grok Build: https://x.ai/cli ; https://docs.x.ai/build/overview ; https://rywalker.com/research/grok-build ; https://codersera.com/blog/xai-grok-build-skills-connectors-guide-2026/
- Muse Code: https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2 ; https://dev.meta.ai/resources/blog/muse-code-new-plans-and-features
- Kilo Code history (OpenCode-based CLI, Anaconda acquisition, VS Code installs): https://faun.dev/toolbox/kilo-code-vs-qwen-code/
- Cursor CLI entrypoint rename to `agent`: https://cursor.com/changelog/cli-jan-08-2026 ; changelog: https://cursor.com/docs/cli/changelog
- Kimi CLI archived in favor of Kimi Code: https://github.com/MoonshotAI/kimi-cli
- Amp npm rename: https://ampcode.com/news/npm-package-changes (per npm description of `@sourcegraph/amp`)

## Excluded or demoted, and why

| Candidate | Outcome | Reason |
|---|---|---|
| Goose (#11) | Runner-up; now supported (`runtime: goose`, [goose.md](goose.md)) | 54.8k stars but only about 60k CLI binary downloads/month and 1,156 Homebrew; much of its audience uses the desktop app. Within 0.03 of #10. |
| Kiro CLI (#12) | Runner-up; now supported (`runtime: kiro`, [kiro.md](kiro.md); no resume, readiness partly derived) | Amazon Q Developer CLI was rebranded to Kiro CLI; the `amazon-q` cask no longer exists. Kiro CLI Homebrew 714/30d is comparable to Cursor CLI, but no stars or vendor claim specific to the CLI. Within 0.03 of #10. |
| Kimi Code (#13) | Runner-up | Solid measured npm (154k) but small Homebrew and star counts. Legacy `kimi-cli` is archived. |
| Crush (#14) | Runner-up | 28k stars but under 100k measured installs. |
| Open Interpreter (#15) | Runner-up | High stars (68k) from its 2023-2024 peak; 29k PyPI/month now; less of a coding agent than a general computer-use shell. |
| Mistral Vibe (#16) | Runner-up | Raw PyPI number is CI-dominated (see methodology). |
| Muse Code (#17) | Runner-up | Launched 2026-08-05, out of beta 2026-08-31; too new to have adoption data. Worth re-checking in a quarter. |
| Continue CLI (#18), Factory Droid (#19), Amp (#20), Auggie (#21) | Runners-up | Each under ~210k measured installs with little or no Homebrew or star signal. Amp is notable on npm (204k combined) but closed source and nearly absent from Homebrew. |
| Junie CLI (#22) | Runner-up | About 1k npm downloads/month. |
| Warp | Excluded | It is a terminal emulator with a built-in agent, not a CLI you launch inside a tmux pane. Cask `warp` 3,011/30d. |
| Amazon Q Developer CLI | Excluded | Rebranded to Kiro CLI; the Homebrew `amazon-q` cask has been removed. Evaluated as Kiro CLI. |
| Plandex | Excluded | Last push to plandex-ai/plandex was 2025-10-03; effectively inactive. |
| Kimi CLI (Python) | Excluded | Repo archived; replaced by Kimi Code. |
| iFlow CLI, community Grok CLI | Excluded | Under 4k downloads/month; community Grok CLI superseded by official Grok Build. |
| Rovo Dev CLI | Excluded | Ships as a subcommand of Atlassian's `acli`; no separable public adoption data. |

## Adapter facts for the top 10

These facts were gathered as adapter design input on 2026-09-29 against the then-current releases. Where a runtime-specific page exists in this directory, it supersedes this matrix. Methods: `--help` output from the npm package run in a scratch directory; source read via `gh api` or a shallow clone; binary string inspection for closed-source tools. OpenCode, Kilo, and Copilot TUIs were also launched in an isolated tmux server with a throwaway home directory to capture the idle screen. Items not confirmed are marked "unverified".

### Cross-cutting adapter gotchas

1. **Bare `agent` on PATH is ambiguous.** The Grok Build installer creates `~/.grok/bin/agent` as a symlink to `grok`. When both are installed, `which agent` can resolve to Grok rather than Cursor. A Cursor adapter should launch `cursor-agent` or an absolute path (`~/.local/bin/agent`).
2. **What a positional prompt does differs.** `gemini "x"`, `agent "x"` (Cursor), and `grok "x"` stay interactive. `qwen "x"` and `cline "x"` run once and exit; use `-i` to stay interactive. OpenCode and Kilo use `--prompt`; Copilot uses `-i`. Aider has no way to seed a prompt interactively (only `--load <file>` of slash commands).
3. **Trust gates block the first prompt.** Copilot ("Confirm folder trust"), Cursor ("Do you trust the contents of this directory?"), Grok ("Do you trust the contents of this directory?"), and Gemini/Qwen (trusted folders) can each show a modal before the input box appears. Pre-trust through config or flags (`--trust`, `--skip-trust`, `GROK_FOLDER_TRUST=0`, Copilot `trustedFolders`) or have the adapter detect and answer the modal.
4. **Placeholder punctuation varies across forks.** OpenCode uses `Ask anything…` (Unicode ellipsis) and Kilo uses `Ask anything...` (ASCII). Match on `Ask anything` only.
5. **Shared home directories.** Antigravity CLI lives under `~/.gemini/antigravity-cli/` and reads `~/.gemini/GEMINI.md` and `~/.gemini/AGENTS.md`, so it overlaps with Gemini CLI.
6. **Fork families.** Kilo CLI is an OpenCode fork (same flags, `KILO_*` env prefix, `kilo.json`). Qwen Code is a Gemini CLI fork (same TUI strings, different positional-prompt semantics and `auto-edit` spelling). One adapter per family, with small overrides, would cover 4 of the 10.

### Summary matrix

| CLI | Binary | Model | Auto-approve | Continue last / resume id | Headless (+JSON) | Seed prompt, stay interactive | Instruction files | Idle-ready marker |
|---|---|---|---|---|---|---|---|---|
| OpenCode | `opencode` | `-m provider/model` | `--auto` | `-c` / `-s <id>` | `opencode run "..." --format json` | `--prompt "..."` | AGENTS.md (fallback CLAUDE.md) | placeholder `Ask anything…`; footer `tab agents  ctrl+p commands` |
| Copilot CLI | `copilot` | `--model` | `--yolo` / `--allow-all` | `--continue` / `--resume=<id>` | `-p "..." --output-format json` | `-i "..."` | AGENTS.md, CLAUDE.md, GEMINI.md, .github/copilot-instructions.md | line starting `❯` between rules; footer `/ commands · ? help` |
| Gemini CLI | `gemini` | `-m` | `-y` / `--yolo` | `-r` (latest) / `-r <idx or uuid>` | `-p "..." -o json` | `-i "..."` or positional | GEMINI.md (configurable via `context.fileName`) | placeholder `Type your message or @path/to/file`; `? for shortcuts` |
| Cursor CLI | `cursor-agent` (or `agent`) | `--model` | `-f` / `--yolo` | `--continue` / `--resume <chatId>` | `-p --output-format json` | positional | .cursor/rules, AGENTS.md, CLAUDE.md | placeholder `Plan, search, build anything` (new) / `Add a follow-up` |
| Kilo CLI | `kilo` | `-m provider/model` | `--auto` | `-c` / `-s <id>` | `kilo run "..." --format json` | `--prompt "..."` | AGENTS.md (fallback CLAUDE.md) | placeholder `Ask anything...`; footer `tab agents  ctrl+p commands` |
| Cline CLI | `cline` | `-m <id> -P <provider>` | `--auto-approve true` (default true) | none / `--id <id>` | `cline "..." --json` | `-i "..."` | AGENTS.md, .clinerules, .cline/rules | placeholder `What can I do for you?` / `Ask anything...` |
| Antigravity CLI | `agy` | `--model` | `--dangerously-skip-permissions` | `-c` / `--conversation <id>` | `-p "..." --output-format json` | `-i "..."` | AGENTS.md, GEMINI.md, .agents/rules | `? for shortcuts` (unverified in live pane) |
| Qwen Code | `qwen` | `-m` | `-y` / `--yolo` | `-c` / `-r <id>` | `-p "..." -o json` | `-i "..."` | QWEN.md, AGENTS.md | placeholder `Type your message or @path/to/file`; `? for shortcuts` |
| Aider | `aider` | `--model` | `--yes-always` | `--restore-chat-history` / none | `--message "..."` (no JSON) | none (`--load <file>`) | none auto; `--read CONVENTIONS.md` | prompt line `> ` (or `architect> `, `ask> `, `multi> `) |
| Grok Build | `grok` | `-m` | `--always-approve` (aliases `--yolo`) | `-c` / `-r <id or title>` | `-p "..." --output-format json` | positional | AGENTS.md, CLAUDE.md, .grok/rules, .claude/rules, .cursor/rules | placeholder `Build anything` |
