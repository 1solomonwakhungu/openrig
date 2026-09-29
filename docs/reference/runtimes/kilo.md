# Kilo CLI runtime (`runtime: kilo`)

OpenRig runs [Kilo CLI](https://kilo.ai/docs/code-with-ai/platforms/cli) as an interactive TUI in the seat's tmux pane. Kilo CLI is a fork of OpenCode with the same flags and TUI, so this adapter shares its launch, pattern, and session-store code with the [OpenCode runtime](opencode.md). This page covers what differs; everything else behaves as that page describes.

## Install

```bash
npm i -g @kilocode/cli
```

This installs `kilo` (and the alias `kilocode`). `rig` preflight probes `kilo --version`. Tested with 7.8.1.

## Auth

The adapter never logs in or writes credentials. Use `kilo auth login` (Kilo account, browser) or `/connect`, or set `KILO_API_KEY` or a provider key such as `ANTHROPIC_API_KEY` in the daemon's environment. With no credentials, Kilo uses its free "Auto Free" model on Kilo Gateway, so there is no login gate to detect.

## Rig spec

```yaml
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: "local:agents/implementer"
        profile: default
        runtime: kilo
        model: anthropic/claude-sonnet-5
        cwd: "."
```

## Differences from OpenCode

| | OpenCode | Kilo CLI |
|---|---|---|
| Binary | `opencode` | `kilo` |
| Per-seat session database | `OPENCODE_DB=<seat>/opencode.db` | `KILO_DB=<seat>/kilo.db` |
| Skills dir | `<cwd>/.opencode/skills/` | `<cwd>/.kilo/skills/` |
| Home placeholder | `Ask anything…` (Unicode ellipsis) | `Ask anything...` (three dots) |
| Default agent | Build | Code |
| Self-update off at launch | `OPENCODE_DISABLE_AUTOUPDATE=1` | `KILO_DISABLE_AUTOUPDATE=1` |

Model (`-m provider/model`), posture (`full_bypass` adds `--auto`, `floor` never does), resume (`-s <ses_ id>` with a pre-launch check of the seat's database), fork (refused), guidance (`AGENTS.md`), and readiness all match OpenCode.

## Known limits

- The same limits as OpenCode.
- Kilo account sign-in is not affected by the per-seat database. `kilo auth login` stores the Kilo Gateway token in the shared `auth.json`, the gateway reads it from there, and on every startup Kilo copies `auth.json` into the seat database's credential table.
- Project skills under `.kilo/skills/` load, but Kilo treats them as project-scoped (not trusted for shell injection). Kilo only fully trusts global and `KILO_CONFIG_DIR` skills.
- The npm package runs `node` as a launcher for a native `.kilo` binary, so the pane's foreground command is `node`. The runtime is identified from the launcher's arguments; `node` alone is never treated as Kilo.
- A single `ctrl+c` at the idle prompt did not exit Kilo 7.8.1 in live testing, so stopping a seat never relies on keystrokes.
- Kilo's one-time Claude migration shows a notification, not a blocking modal, so it needs no attention gate.

## What was verified live

Verified on 2026-09-29 against kilo 7.8.1 (npm, installed into an isolated prefix), in an isolated tmux server with a throwaway `HOME` and no credentials:

- `--help` flags: `-m`, `-c`, `-s`, `--fork`, `--prompt`, `--auto`, plus Kilo-only `--cloud-fork` and `--worktree`.
- The home idle screen (`Ask anything...`, `Code · Auto Free Kilo Gateway`, `tab agents  ctrl+p commands` footer).
- The pane's foreground process is `node`, with the child binary `.kilo`.
- The `session` table schema is byte-identical to OpenCode 1.18.33's.
- With a per-seat `KILO_DB`, `kilo auth list` reports the credential from the shared `auth.json`, and the seat database's credential table holds the imported copy (probed with a fake key).

Read from source (Kilo-Org/kilocode, main at 2026-09-29): `KILO_DB` resolution, the session id prefix, `.kilo` project config and skills scanning, the migration notification, the `Session not found` TUI error shared with OpenCode, and where Kilo Gateway login is stored (`auth.json`, read with `auth.get("kilo")`).
