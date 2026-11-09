# Changelog

All notable changes to `dsh-wsl-sidebar` are documented here.

## Unreleased

Documentation only; no behavior change.

- Animated GIF in the README: the full new-session flow — click 🐧 **WSL folder**, pick a distro, browse, open the workspace.
- More npm keywords (`wsl2`, `linux`, `distro`, `bash`, `shell`) so the plugin is easier to find.

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
