# WSL Sidebar for DeepSeek Harness

A single, self-contained plugin: a **WSL** page in Settings and a set of
`wslx-*` tools that run **native Linux commands inside a distribution**.

Installing this plugin alone is enough to browse WSL, to work in a WSL
workspace, and to keep long-running processes and interactive shells alive —
no `dsh-wsl-tool`, no `ops_bash`, no Windows ACL preparation.

## Settings page

**Settings → WSL** opens a console with three tabs. It used to be a sidebar
panel; it lives in Settings because that is where the other global surfaces of
this app are, and it keeps the left column for sessions:

| tab | what it shows |
| --- | --- |
| 发行版 / Distros | every distribution from `wsl.exe -l --verbose` with running state, WSL version and the default marker; start, stop, set default, switch a distro to WSL 1 or 2 |
| 配置 / Config | `.wslconfig` (global) and `/etc/wsl.conf` (per distro) as a typed form — memory limit, processors, swap, networking mode, localhost forwarding, systemd, default user — plus a raw view of the same file |
| 运行态 / Runtime | per-distro memory and disk usage, load, uptime, listening ports and process count |

The console is driven by you, not by the model: nothing is written until you
press **保存 / Save**, and each file is written the way its owner expects —
`.wslconfig` through a temp file and an atomic rename on the Windows side,
`/etc/wsl.conf` through `wsl.exe -u root`, keeping existing comments and unknown
keys. Saving **never restarts WSL**: the tab says so and offers a
**立即重启 / Restart now** button that runs `wsl --shutdown` only after a second
confirmation, because that kills every running distribution.

These writes are your own clicks in the panel, so they do not pass the tool gate
that guards `asRoot` and destructive commands — that gate exists for what the
model asks to run.

Every drop-down in the panel is drawn by the panel itself rather than by a native
`<select>`: an OS-drawn popup picks its own colours, and its highlighted row is
unreadable on the dark theme. Buttons and tabs track their hover state inline for
the same reason — the panel is injected into someone else's stylesheet.

The page deliberately stops at administration: browsing folders and creating
workspaces happens where a session is created (see the next section), not here.

## New-session entry

A new conversation shows a **🐧 WSL 目录 / WSL folder** chip next to the other
hero options. It opens the same distro + directory picker in a dialog, and
**选择此目录 / Use this folder** creates the `\\wsl.localhost\<distro>\<path>`
workspace and switches the draft session to it — the same thing the built-in
"add workspace" flow does for a Windows folder, so a WSL folder can be picked at
the moment the session is created.

The chip and the settings page talk to the same Host half: the chip uses
`/distros` and `/list`, the page uses `/admin/*`. The chip appears in the
hero because `conversation.hero.options` is a list slot that stays additive to
the shipped workspace picker.


## Tools

| tool | what it does |
| --- | --- |
| `wslx-run` | run a bash command (`rg`, `git`, `make`, `python3`, …) in the distro; optional `workdir`, `timeoutMs`, and a destructive-command guard |
| `wslx-read` | read a file with line numbers, 2000 lines per call |
| `wslx-write` | write a whole file through a Linux-side stdin pipe |
| `wslx-edit` | replace an exact string; the file keeps its mode and owner |
| `wslx-search` | regex search with `rg`, falling back to `grep -E`; up to 250 matches |
| `wslx-bg` | keep a process alive across calls: `start` (a command, or `mode=shell` for an interactive `bash -i`), `output` (incremental, by cursor), `input` (one line to stdin), `kill`, `list` |

Every file/command tool accepts `asRoot: true`, which runs that call as the
distribution's Linux root through `wsl.exe -u root`. The Windows process does not
need to be elevated for that; it is the same root the WSL distro already has.

Every one of them resolves its distribution the same way:

1. an explicit `distro` argument (validated against `wsl -l -q`, with the
   installed names listed when it is wrong);
2. the distribution the calling session's workspace already lives in, read from
   the `\\wsl.localhost\<distro>\...` path of the session;
3. `DSH_WSL_DISTRO` when the environment sets it (useful for Windows-path workspaces),
4. otherwise `wsl.exe`'s own default — and the tool header always prints which
   distribution actually ran, so a surprise default is visible instead of silent.

Work directories resolve the same way in reverse: `/home/...` stays as it is,
`C:\Users\...` becomes `/mnt/c/Users/...`, and a UNC path maps to its Linux path.

## Background tasks and interactive shells

`wslx-bg` keeps one `wsl.exe` child open per task:

- `start` with `mode=command` runs a bash command and keeps its output readable
  afterwards; `mode=shell` keeps an interactive `bash -i` open, so `python3 -i`,
  `psql`, `ssh`, `mqtt` clients and `sudo` password prompts work line by line.
- `output` returns only what was written after the `cursor` the previous call
  returned, so polling a noisy job does not re-read the whole log.
- `input` writes one line to stdin, `kill` sends Ctrl-C and then kills the
  Windows process tree (its Linux children go with it), `list` shows every task.
- Tasks live in the plugin process: they die with the Harness, never leave a
  daemon behind, cap their output at 1 MiB, and default to a 30-minute TTL.

There is no pseudo-terminal, so a full-screen TUI (`vim`, `top`, `htop`) cannot
render. For those, open the distribution's own terminal; everything that reads
lines instead of drawing screens is fine.

## Why the tools exist

`\\wsl.localhost` is a 9p share, not a Windows filesystem:

- a Windows-side writer uses temp-file + rename, which the share cannot do, so
  writes through the UNC path fail (a read-only sandbox makes it worse);
- `dsh-ops` prepares a workspace root by rewriting its ACL before tagging it,
  and the 9p share returns no security descriptor — `Get-Acl` always throws, so
  `ops_bash` cannot start in a `\\wsl.localhost\` workspace at all.

These tools never touch that path: every operation becomes one `wsl.exe -d
<distro> -e bash -lc <script>` call, so reads and writes happen on the Linux
side of the boundary, as native Linux commands.

## Install

From the public repository — one command, no build step and no `allowBuilds`
prompt, because the package ships plain ESM:

```sh
dsh plugin add github:Wang1462604987/dsh-wsl-sidebar
```

or the same plugin from npm:

```sh
dsh plugin add dsh-wsl-sidebar
```

Restart the Harness afterwards: the client half is bundled at boot, so a reload
is not enough.

For local development, copying the folder into a profile's `node_modules` (or
linking it, `link:/path/to/dsh-wsl-sidebar`) and keeping the `wsl-sidebar` row
enabled in the profile's `cordis.patch.yml` is enough.

`node scripts/selfcheck.mjs [distro]` re-checks the parts that have broken
before: UNC path mapping, workspace-driven distro choice, `asRoot` reaching uid
0, the destructive-command guard, a write/read/edit round trip, and a background
task read by cursor.

The console has its own checks that need no Harness and no browser:

- `node scripts/mountcheck.mjs` — mounts `apply()` against a fake context,
  exercises the tool gate, and drives all seven routes with fake request objects
  (distros, config read/save, action validation, status sampling).
- `node scripts/httpcheck.mjs` — starts a real `http.Server`, registers the same
  routes and calls them with `fetch`, so stream reading, status codes, headers
  and the 413/400 paths are checked the way the web server uses them. It writes
  `.wslconfig` and restores the original bytes before exiting.

## Coexistence with dsh-wsl-tool

`dsh-wsl-tool` registers `wsl`, `wsl-read`, `wsl-write`, `wsl-edit` and others;
DSH registers tools by name, so this plugin deliberately uses the `wslx-` prefix
and both can be installed at once. To keep only this one, disable the bundle's
own row — its id is `tool-wsl`, not the package name:

```yaml
- id: tool-wsl
  disabled: true
```

(`dsh-wsl-tool`'s bundle inserts itself as `tool-wsl`, so a row keyed
`dsh-wsl-tool` matches nothing.)

## Limits

- No full-screen TUI: see the background-task section.
- A task's output beyond 1 MiB is dropped from the front and reported as such.
- The tools run as the Linux user of the distribution (or root with `asRoot`);
  there is no extra sandbox between the model and that user.

## 权限与危险命令

两个操作越过「读我的文件」，它们都要 DSH 先给授权：

- **root 提权**（任何工具的 `asRoot: true`）。允许的条件只有两条：会话当前已是
  `danger-full-access`，或用户在这一次调用上点了同意（走 DSH 的 approval 通道）。
  没有审批通道时失败关闭，什么都不执行——不会再默默用 root 跑。
- **危险命令**（删掉文件系统根、家目录根、`/mnt/c/Windows`；`mkfs`、`dd of=/dev/*`、
  fork 炸弹、关机/重启、`wsl --unregister` 删发行版……）。默认直接拒绝；
  `allowDangerous: true` 只是「我确实要做」的声明，仍然需要 `danger-full-access`
  或一次用户同意。

判定逻辑是可测的纯函数（`lib/tools.js` 的 `destructiveReason`），
`node scripts/selfcheck.mjs` 里正反用例都覆盖：`rm -rf /`、`rm -rf /*`、`rm -rf ~`、
`rm -rf $HOME/*`、`rm -rf /home/hugo`、`rm -rf /mnt/c/Windows`、`wsl --unregister` 被拦，
`rm -rf build`、`rm -rf /home/hugo/temp/<项目>`、`git commit -m 'reboot handling'` 放行。
