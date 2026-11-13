# Changelog

All notable changes to `dsh-wsl-sidebar` are documented here.

## Unreleased

- **The session picker can create folders.** A **＋ 新建文件夹 / New folder** button next to the path line: the folder is created in the directory you are browsing and the dialog walks straight into it, ready to open as a workspace. Collisions answer inline; a stopped distribution is reported, never started.
- **A terminal entry sits right above the composer — but only for WSL workspaces.** When the session's workspace lives inside WSL, one click opens a real terminal window in that workspace's distribution, already cd'd into the working directory (Windows Terminal when installed, a plain console window otherwise). Sessions on Windows directories show no entry; there is no distro picker on purpose.
- **A `wslx-run` deadline no longer kills the command.** When the deadline is reached the child is adopted as a background task: the result reports the captured output so far and names the task, which `wslx-bg` keeps readable (`action=output taskId=…`). Nothing times out into the void.
- **The Runtime tab shows background tasks live.** Every task's id, command, state and recent output poll every five seconds, with a kill button — a long command the agent adopted stays visible (and stoppable) without asking anyone how it went.
- **Long commands report themselves.** The `wslx-run` result and description tell the agent to announce the task id and, when a command is expected to take minutes, schedule a one-time follow-up (the harness `schedule_create` at about ETA + 2 minutes) that reads the task with `wslx-bg` and reports the outcome unasked.
- **`wslx-bg` tasks now expire on idle, not on an absolute clock.** Reading or writing a running task restarts its time-to-live budget, so a task someone is still watching never dies mid-work.
- The confirmation dialog for restricted deployments explains itself in the user's language; the host's reason stays as the detail line.
- Documentation: animated GIF in the README (the full new-session flow), more npm keywords (`wsl2`, `linux`, `distro`, `bash`, `shell`).

## 1.7.2 — 2026-10-30

Documentation and packaging only.

- Bilingual README (English / 中文) and a dedicated zh-CN edition.
- Marketplace packaging: icons and screenshots for the plugin listing.

## 1.7.1 — 2026-10-30

- **A stopped distribution is never started implicitly.** Reading `/etc/wsl.conf` or browsing its directories would wake a stopped distro; both now answer `distro-stopped` (the routes answer `409`) with an explanation and a start button instead.
- Configuration writes keep `.bak-<date>` backups next to the target file (introduced in 1.7.0, kept).

## 1.7.0 — 2026-10-29

First published to npm as part of 1.7.1.

- The panel moved from the sidebar into **Settings → WSL** with tabs for Distros, Config and Runtime; the directory Tab was removed in favour of the new-session entry.
- Destructive admin actions (stop a distro, switch WSL 1 ↔ 2, export its disk, `wsl --shutdown`) require an explicit confirmation when the deployment's default permission is not `danger-full-access`.
- Platform guard: on a non-Windows host every route and tool refuses with an explanation.
- Background tasks are disposed with the plugin; no process survives the harness.
- CI workflow (`rendercheck` on ubuntu + node 22) and a README troubleshooting section.

## Upgrade compatibility

Identifiers this plugin publishes are permanent. The Host route prefix (`/__wsl_plugin__/…`), tool names (`wslx-run`, `wslx-read`, `wslx-write`, `wslx-edit`, `wslx-search`, `wslx-bg`), the slot ids (`wsl-sidebar`, `wsl-dir`) and any agent preset ids a version declared must never be renamed or dropped: sessions created by an old version store those names, and a missing definition turns into a failed session resume (`agent-preset/not-found`). Renames, if ever needed, ship as new ids with the old ones kept as aliases — never as in-place changes.
