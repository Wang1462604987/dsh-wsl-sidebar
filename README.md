# dsh-wsl-sidebar

<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-CN.md">中文</a></p>

<p align="center"><strong>WSL plugin for DeepSeek Harness</strong> — <em>your agent, running inside the distribution.</em></p>

<p align="center"><sub>a WSL console in Settings · six <code>wslx-*</code> tools · native Linux commands · background tasks and interactive shells</sub></p>

<p align="center">
<a href="https://www.npmjs.com/package/dsh-wsl-sidebar"><img src="https://img.shields.io/npm/v/dsh-wsl-sidebar.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/Wang1462604987/dsh-wsl-sidebar/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/dsh-wsl-sidebar.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/Wang1462604987/dsh-wsl-sidebar"><img src="https://img.shields.io/badge/GitHub-Wang1462604987%2Fdsh--wsl--sidebar-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>dsh plugin add dsh-wsl-sidebar</code>
</p>

<p align="center">
<a href="https://www.deepseek.com" title="deepseek-harness (dsh)"><img src="https://cdn.simpleicons.org/deepseek/5786FE" height="26" alt="deepseek-harness"></a>
</p>

---

> **Design rule:** the agent never writes through `\\wsl.localhost`. Every read, write, edit and search becomes one `wsl.exe -d <distro> -e bash -lc <script>`, so the work happens on the Linux side of the boundary, as ordinary Linux commands.

## Why

`\\wsl.localhost` is a 9p share, not a Windows filesystem:

- Windows-side writers use "temp file + rename", which that share cannot do — writing from a UNC path fails, and fails deterministically under a read-only sandbox;
- a workspace gets its ACL rewritten before anything is tagged, but a 9p share returns no security descriptor — `Get-Acl` throws, so a Windows-side shell cannot start in a `\\wsl.localhost\` workspace at all.

A single Windows-side process also speaks for one distribution at a time: point it at a file in another distro and the path resolves to the first one.

This plugin sidesteps both: it talks to `wsl.exe` directly and executes inside whichever distribution the request names, so a WSL workspace, a second distro and a stopped distro are each exactly what they are.

## How it works

Two halves that meet over the harness web server:

- **Host half** (`index.js`, `lib/*.js`) registers seven routes under `/__wsl_plugin__/` — distro listing, directory listing, administration, configuration, runtime status, logs — plus the six `wslx-*` tools. Requests from anything but the owner web session are rejected.
- **Client half** (`client.js`) renders the Settings page and the new-session entry, and calls those routes with the session the page already has.

Distribution resolution, in order:

1. the explicit `distro` argument (validated against `wsl -l -q`; a wrong name lists what is installed);
2. the distro of the workspace the session runs in (read from `\\wsl.localhost\<distro>\...`);
3. the `DSH_WSL_DISTRO` environment variable (useful with Windows-path workspaces);
4. otherwise `wsl.exe`'s own default — and every tool prints the distribution it actually ran in, so a fallback is visible instead of silent.

Working directories map back the other way: `/home/...` stays as written, `C:\Users\...` becomes `/mnt/c/Users/...`, and a UNC path maps to its Linux form.

## Settings page

Three tabs under **Settings → WSL**:

| Tab | What it does |
| --- | --- |
| Distros | Each distribution's state and WSL version, plus start, stop, set default and switching between WSL 1 and 2. |
| Config | `.wslconfig` (global) and `/etc/wsl.conf` (per distro): memory cap, processor count, swap, networking mode, localhost forwarding, systemd, default user — as a form, with a raw-text view alongside. |
| Runtime | Memory and disk usage, load, uptime, listening ports and process count for one distribution, from plain Linux tools (`free -b`, `df -B1`, `ss`, `/proc`). |

Deliberate choices:

- **Disk writes happen on save, not on typing.** Each file is written its own way: `.wslconfig` through a temp file and an atomic rename, `/etc/wsl.conf` through `wsl.exe -u root`. Comments and unknown keys survive.
- **Saving does not restart WSL.** The page says so and offers a restart button; `wsl --shutdown` asks for confirmation first, because it stops every distribution.
- **Every write keeps a backup:** `.wslconfig.bak-<date>` and `/etc/wsl.conf.bak-<date>`, and the page shows where it landed.
- **Destructive buttons have their own gate.** When the deployment's default permission is not `danger-full-access`, stopping a distro, switching its version, exporting a disk and `wsl --shutdown` all require a confirmation, and the host rejects any request without the matching `acknowledge`. This is not a sandbox — the model and the page share one authenticated browser session — it guards against a misclick.
- **A stopped distribution is never started implicitly.** Reading `/etc/wsl.conf` means running a command inside the distro, which would wake it; a stopped distro therefore shows an explanation and a start button only. Directory browsing behaves the same way and answers `distro-stopped`.
- **Dropdowns are drawn by the page.** A native `<select>` popup follows the system palette, and on a dark theme the highlighted row is unreadable.

## New-session entry

Next to the other entry points on the new-session page there is a **🐧 WSL 目录** button. It opens a distro-and-directory picker; "choose this directory" creates a `\\wsl.localhost\<distro>\<path>` workspace and switches the draft session to it, exactly what the built-in workspace picker does for Windows directories.

## Tools

| Tool | What it does |
| --- | --- |
| `wslx-run` | Run a bash command inside a distribution (`rg`, `git`, `make`, `python3`…); optional `workdir` and `timeoutMs`; dangerous commands are intercepted. |
| `wslx-read` | Read a file with line numbers, 2000 lines per call. |
| `wslx-write` | Write a whole file through a Linux-side stdin pipe. |
| `wslx-edit` | Replace one exact string; the file's mode and owner stay unchanged. |
| `wslx-search` | Regex search with `rg`, falling back to `grep -E`; at most 250 matches. |
| `wslx-bg` | Keep a process alive across calls: `start` (a command, or `mode=shell` for an interactive `bash -i`), `output` (incremental, by cursor), `input` (one line to stdin), `kill`, `list`. |

Every tool accepts `asRoot: true`, which runs that one call as the distribution's Linux root through `wsl.exe -u root`. The Windows process itself needs no elevation — it uses the root the distro already has. The names carry a `wslx-` prefix, so they never collide with another bundle's tool names.

## Background tasks and interactive shells

`wslx-bg` keeps one `wsl.exe` child process per task:

- `start` with `mode=command` runs a bash command, and its output stays readable after it finishes; `mode=shell` keeps an interactive `bash -i`, so `python3 -i`, `psql`, `ssh`, an MQTT client and a `sudo` password prompt all work a line at a time.
- `output` returns only what was written after the cursor you pass, so polling a noisy task does not re-read the log.
- `input` writes one line to stdin; `kill` sends Ctrl-C first and then kills the Windows process tree (the Linux children go with it); `list` shows every task.
- Tasks live inside the plugin process: when the harness exits, they are gone, and no daemon is left behind. Output is capped at 1 MiB and the default time-to-live is 30 minutes.

There is no pseudo-terminal, so full-screen programs such as `vim`, `top` and `htop` cannot draw. Anything that reads and writes line by line works.

## Install

From the repository, one command, no build step and no `allowBuilds` confirmation, because the package is native ESM:

```sh
dsh plugin add github:Wang1462604987/dsh-wsl-sidebar
```

Or from npm:

```sh
dsh plugin add dsh-wsl-sidebar
```

**Restart the harness afterwards**: the client half is bundled at startup, so reloading the page is not enough.

## Quickstart

1. **Settings → WSL → Distros** — check the list, start the distribution you want, mark it default if it should answer when nothing else says otherwise.
2. **Config** — set the `.wslconfig` or `/etc/wsl.conf` values you usually edit by hand, save, then restart the distribution when the page says so.
3. **New session** — click **🐧 WSL 目录**, pick a folder, and the session opens on `\\wsl.localhost\...`.
4. **Ask** — "list the files here and run the tests": the agent reaches for `wslx-run` and `wslx-search` in the distribution your workspace belongs to.

## Self-checks

Four scripts, no framework:

- `node scripts/rendercheck.mjs` — boots `client.js` against a small React (hooks, effects, a fake `fetch`) and mounts the Settings page: 29 assertions over the three tabs, hover colours, the drawn dropdowns, the confirmation flow, the backup notice, the stopped-distro copy and the non-Windows notice. Node only.
- `node scripts/mountcheck.mjs` — mounts `apply()` with a fake context: tool gates, platform guard, admin-action gate, and fake request objects for all eight routes.
- `node scripts/httpcheck.mjs` — starts a real `http.Server` and calls the routes with `fetch`, so streamed reads, status codes, headers and the 413/400 paths all go through the real web-server path. It writes `.wslconfig` and restores the original bytes on exit.
- `node scripts/selfcheck.mjs [distro]` — needs real WSL: UNC mapping, `asRoot` actually reaching uid 0, dangerous-command blocking, write/read/edit round-trips, cursor reads on a background task, and a stopped distribution staying stopped.

`.github/workflows/checks.yml` runs the syntax checks and `rendercheck` on every push and pull request; the other three need real WSL and run locally (or on a Windows runner with a distribution installed).

## Limits

- **Windows only.** The host half checks `process.platform` first and answers `supported: false` elsewhere, so the page explains itself instead of showing three tabs full of `wsl.exe` errors.
- No full-screen TUI (see above).
- One task's output beyond 1 MiB is dropped from the front, with a note in the output.
- Tools run as the distribution's Linux user (or root with `asRoot`); there is no extra sandbox between the model and that account.

## Troubleshooting

- **The distro list is empty.** WSL is not installed, or `wsl.exe` on `PATH` is the Store stub. Get `wsl.exe -l -v` working in PowerShell first.
- **A directory will not open, or `\\wsl.localhost\<distro>\...` does not resolve.** WSL 1 distributions have no UNC path; convert with `wsl --set-version <distro> 2`.
- **The page is missing after install.** The client half is bundled at startup — restart the harness, a page reload is not enough.
- **A Windows-side shell reports an ACL or sandbox error in a `\\wsl.localhost\...` workspace.** That share is a 9p mount with no Windows security descriptor, so the host sandbox cannot describe it. It is a platform limit, not a plugin bug; use the `wslx-*` tools there.
- **Writing `/etc/wsl.conf` fails.** The write runs as `wsl.exe -u root`; a distribution with root login disabled (or a read-only `/etc`) refuses. Edit the file once by hand, then refresh.
- **The directory picker refuses a distro.** It is stopped. The dialog has a start button; nothing starts implicitly.
- **Stop or version-switch does nothing.** The deployment's default permission is not `danger-full-access`, so the first click only opens a confirmation dialog and sends nothing until you confirm.

## Permissions and dangerous commands

Two operations go beyond "read my files", and both need the harness to authorize them first:

- **Root** (any tool's `asRoot: true`). Allowed in exactly two cases: the session is already `danger-full-access`, or the user approves this particular call through the harness's approval channel. Without an approval channel it fails closed and runs nothing — there is no silent root.
- **Dangerous commands** (deleting a filesystem root, a home root or `/mnt/c/Windows`; `mkfs`, `dd of=/dev/*`, fork bombs, shutdown/reboot, `wsl --unregister`). Refused by default; `allowDangerous: true` states "I really mean it" and still needs `danger-full-access` or one user approval.

The decision is a pure, testable function (`destructiveReason` in `lib/tools.js`), covered both ways by `node scripts/selfcheck.mjs`: `rm -rf /`, `rm -rf /*`, `rm -rf ~`, `rm -rf $HOME/*`, `rm -rf /home/hugo`, `rm -rf /mnt/c/Windows` and `wsl --unregister` are refused, while `rm -rf build`, `rm -rf /home/hugo/temp/<project>` and `git commit -m 'reboot handling'` are allowed.

## Development

Link the checkout into a profile's `node_modules` (or use a `link:` dependency), and keep the bundle's own line in the profile's `cordis.patch.yml`:

```yaml
- id: wsl-sidebar
  # the bundle inserts itself under this id, not under the package name
```

Restart after changing either half; the client bundle is packaged at boot.

## Status

Version 1.7.1. Tested on Windows 11 with Ubuntu 24.04 on WSL 2 (3.0.3.0), including the stopped-distribution behaviour on Arch Linux.

## License

MIT — see [LICENSE](LICENSE).
