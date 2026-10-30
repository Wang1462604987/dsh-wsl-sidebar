# WSL Sidebar for DeepSeek Harness

给 DeepSeek Harness 的 WSL 插件：**设置里一页 WSL 控制台**，加上一组在发行版内执行原生 Linux 命令的 `wslx-*` 工具。装这一个插件就够——浏览 WSL、在 WSL 目录里开工作区、跑长驻进程和交互式 shell，不用再装 `dsh-wsl-tool`，不经过 `ops_bash`，也不用提前准备 Windows ACL。

## 设置页：设置 → WSL

三个标签页：

| 标签 | 内容 |
| --- | --- |
| 发行版 / Distros | 每个发行版的运行状态、WSL 版本、默认标记；启动、停止、设为默认、在 WSL 1 与 2 之间切换 |
| 配置 / Config | `.wslconfig`（全局）与 `/etc/wsl.conf`（单个发行版）的表单：内存上限、处理器数、swap、网络模式、localhost 转发、systemd、默认用户，另有原文视图 |
| 运行态 / Runtime | 单个发行版的内存与磁盘占用、负载、运行时长、监听端口、进程数 |

几个刻意的设计：

- 写盘只发生在你点「保存」的时候。两个文件按各自宿主的方式写：`.wslconfig` 走临时文件加原子 rename，`/etc/wsl.conf` 走 `wsl.exe -u root`，原有注释和它不认识的键都会保留。
- 保存**不会**重启 WSL。页面会这么提示，并给一个「立即重启」按钮；`wsl --shutdown` 要二次确认才执行，因为它会把所有发行版都停掉。
- 每次写入都留备份：`.wslconfig.bak-<日期>` 和 `/etc/wsl.conf.bak-<日期>`，页面会显示备份落在哪里。
- 破坏性按钮有自己的闸门：部署默认权限不是 `danger-full-access` 时，停止发行版、切 WSL 版本、导出磁盘、`wsl --shutdown` 都要先确认，Host 没收到 `acknowledge` 一律拒绝。这不是沙箱（也做不到——模型和这个页面共用同一个已认证的浏览器端），它防的是误触。
- **不会擅自启动发行版**：读 `/etc/wsl.conf` 等于在发行版里跑命令，会把停着的发行版叫醒，所以停着的发行版只显示说明和一个「启动」按钮；目录浏览同理，返回 `distro-stopped`，点了才启动。
- 下拉框和按钮都是页面自绘的：原生 `<select>` 的弹层跟随系统配色，深色主题下高亮那一行看不见字。

## 新会话：🐧 WSL 目录

新建会话时，其他入口旁边有一个「🐧 WSL 目录」按钮。点开是发行版加目录的选择弹窗，「选择此目录」会创建 `\wsl.localhost\<发行版>\<路径>` 工作区，并把草稿会话切过去——和内置的「添加工作区」对 Windows 目录做的事一样。

## 工具

| 工具 | 作用 |
| --- | --- |
| `wslx-run` | 在发行版里跑 bash 命令（`rg`、`git`、`make`、`python3`……），可选 `workdir`、`timeoutMs`，带危险命令拦截 |
| `wslx-read` | 读文件并带行号，每次 2000 行 |
| `wslx-write` | 通过 Linux 侧 stdin 管道整篇写文件 |
| `wslx-edit` | 替换一段精确文本，文件的 mode 与属主保持不变 |
| `wslx-search` | 用 `rg` 做正则搜索，没有就退到 `grep -E`，最多 250 条 |
| `wslx-bg` | 跨调用保活一个进程：`start`（命令，或 `mode=shell` 开交互式 `bash -i`）、`output`（按 cursor 增量）、`input`（往 stdin 写一行）、`kill`、`list` |

每个工具都按同样的顺序确定用哪个发行版：

1. 显式传入的 `distro`（会对着 `wsl -l -q` 校验，传错时把已安装的列出来）；
2. 调用方会话工作区所在的发行版（从会话的 `\wsl.localhost\<发行版>\...` 路径读）；
3. 环境变量 `DSH_WSL_DISTRO`（配合 Windows 路径工作区时有用）；
4. 都没有就用 `wsl.exe` 自己的默认值——工具头部总会打印实际跑在哪个发行版里，所以意外落到默认值也会被看见，而不是悄悄发生。

工作目录反过来映射：`/home/...` 原样保留，`C:\Users\...` 变成 `/mnt/c/Users/...`，UNC 路径映射到它对应的 Linux 路径。

所有文件和命令工具都接受 `asRoot: true`，让那一次调用以发行版的 Linux root 运行（走 `wsl.exe -u root`）。Windows 进程本身不需要提权，用的就是 WSL 发行版本来就有的 root。

## 后台任务与交互式 shell

`wslx-bg` 每个任务保活一个 `wsl.exe` 子进程：

- `start` 加 `mode=command` 跑一条 bash 命令，跑完输出仍然可读；`mode=shell` 保留一个交互式 `bash -i`，于是 `python3 -i`、`psql`、`ssh`、`mqtt` 客户端、`sudo` 密码提示都能一行一行地交互。
- `output` 只返回上一次 `cursor` 之后写入的内容，轮询吵闹的任务不会把整份日志重读一遍。
- `input` 往 stdin 写一行，`kill` 先发 Ctrl-C 再杀 Windows 进程树（Linux 子进程一起走），`list` 列出全部任务。
- 任务活在插件进程里：Harness 退出就没了，不会留下守护进程；输出上限 1 MiB，默认 30 分钟 TTL。

没有伪终端，所以 `vim`、`top`、`htop` 这类全屏 TUI 画不出来。这类需求请开发行版自己的终端；其余「按行读写」的程序都能用。

## 为什么需要这些工具

`\wsl.localhost` 是 9p 共享，不是 Windows 文件系统：

- Windows 侧写文件用「临时文件 + rename」，这条共享做不到，所以从 UNC 路径写入会失败（只读沙箱下更是必失败）；
- `dsh-ops` 给工作区打标签前要重写它的 ACL，而 9p 共享不返回安全描述符——`Get-Acl` 必然抛错，于是 `ops_bash` 在 `\wsl.localhost\` 工作区里根本起不来。

这些工具不碰那条路径：每次操作都变成一次 `wsl.exe -d <发行版> -e bash -lc <脚本>`，读写发生在边界的 Linux 一侧，就是普通的 Linux 命令。

## 安装

从公开仓库装，一条命令，没有构建步骤也不需要 `allowBuilds` 确认，因为包里是原生 ESM：

```sh
dsh plugin add github:Wang1462604987/dsh-wsl-sidebar
```

或者从 npm：

```sh
dsh plugin add dsh-wsl-sidebar
```

装完要**重启 Harness**：客户端部分在启动时打包，刷新页面不够。

本地开发则是把目录放进 profile 的 `node_modules`（或用 `link:/path/to/dsh-wsl-sidebar` 链接），并在 profile 的 `cordis.patch.yml` 里保留 `wsl-sidebar` 这一行。

## 自测

四套脚本，都不需要框架：

- `node scripts/rendercheck.mjs` —— 用一个小型 React（hooks、effect、`fetch` 桩）把 `client.js` 跑起来并挂载设置页，29 项断言：三个标签页、悬停配色、自绘下拉、确认流程、备份提示、停着的发行版说明、非 Windows 说明。只要 Node。
- `node scripts/mountcheck.mjs` —— 用假 context 挂载 `apply()`，覆盖工具闸门、平台守卫、管理动作闸门，以及八个路由的假请求对象。
- `node scripts/httpcheck.mjs` —— 起真的 `http.Server`，用 `fetch` 打同一批路由，流读取、状态码、header 和 413/400 都按 Web 服务器真实路径校验；会写 `.wslconfig` 并在退出前还原原始字节。
- `node scripts/selfcheck.mjs [发行版]` —— 需要真 WSL：UNC 映射、`asRoot` 是否真到 uid 0、危险命令拦截、写读改往返、后台任务按 cursor 读、停着的发行版不被启动。

`.github/workflows/checks.yml` 每次推送和 PR 跑语法检查加 `rendercheck`；另外三套需要真 WSL，在本地（或装了发行版的 Windows runner）跑。

## 与 dsh-wsl-tool 共存

`dsh-wsl-tool` 注册的是 `wsl`、`wsl-read`、`wsl-write`、`wsl-edit` 这些名字。DSH 按名字注册工具，所以本插件刻意用 `wslx-` 前缀，两者可以同时装。只想留这一个的话，禁用 bundle 自己那一行——它的 id 是 `tool-wsl`，不是包名：

```yaml
- id: tool-wsl
  disabled: true
```

（`dsh-wsl-tool` 的 bundle 以 `tool-wsl` 插入自己，所以按 `dsh-wsl-tool` 建行是匹配不到的。）

## 限制

- 只支持 Windows。Host 半先检查 `process.platform`，其他平台返回 `supported: false`，页面显示说明，而不是三个满屏 `wsl.exe` 报错的标签页。
- 不支持全屏 TUI（见上文）。
- 单个任务输出超过 1 MiB 会从头丢弃，并在输出里注明。
- 工具以发行版的 Linux 用户（或 `asRoot` 时的 root）身份运行，模型与那个用户之间没有额外沙箱。

## 排障

- **发行版列表是空的。** WSL 本身没装，或 `PATH` 上的是占位程序。先在 PowerShell 里把 `wsl.exe -l -v` 跑通。
- **目录打不开，或 `\wsl.localhost\<发行版>\...` 解析不了。** WSL 1 的发行版没有 UNC 路径，用 `wsl --set-version <发行版> 2` 转成 WSL 2。
- **装完设置里没有。** 客户端部分在启动时打包，必须重启 Harness，刷新页面不行。
- **`ops_bash` 在 `\wsl.localhost\...` 上报 ACL 或沙箱错误。** 那条共享是 9p 挂载，没有 Windows 安全描述符，宿主沙箱描述不了它——平台限制，不是插件 bug。请改用 `wslx-*` 工具。
- **写 `/etc/wsl.conf` 失败。** 写入以 `wsl.exe -u root` 执行；发行版禁用了 root 登录（或 `/etc` 只读）就会拒。先手动改一次，再刷新页面。
- **目录选择器拒绝某个发行版。** 它停着。弹窗里有「启动」按钮，点了才会启动——任何页面都不会擅自启动发行版。
- **停止、切版本按钮点了没反应。** 部署默认权限不是 `danger-full-access`，第一次点击只打开确认弹窗，没确认前不会发出请求。

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
