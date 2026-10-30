/** Client half of the WSL sidebar plugin: sidebar icon + main panel to browse \\wsl.localhost and open a workspace. */
window.__ModuleLoader__.load({
	id: "dsh-wsl-sidebar",
	factory: (require) => {
		const React = require("react");

		const NS = "dsh-wsl-sidebar";
		const PANEL_ID = "wsl";
		const DISTROS_PATH = "/__wsl_plugin__/distros";
		const LIST_PREFIX = "/__wsl_plugin__/list";
		const LOG_PATH = "/__wsl_plugin__/log";

		const h = React.createElement;

		function makeT(ctx) {
			const text = {
				panel: { en: "WSL", zh: "WSL" },
				distro: { en: "Select distro", zh: "选择发行版" },
				loading: { en: "Loading…", zh: "加载中…" },
				noDistros: { en: "No WSL distro found.", zh: "未发现 WSL 发行版。" },
				empty: { en: "(empty directory)", zh: "(空目录)" },
				goUp: { en: "Up one level", zh: "上一级" },
				opening: { en: "Opening…", zh: "正在打开…" },
				refresh: { en: "Refresh", zh: "刷新" },
				heroEntry: { en: "WSL folder", zh: "WSL 目录" },
				dialogTitle: { en: "Pick a WSL folder", zh: "选择 WSL 目录作为工作区" },
				pick: { en: "Use this folder", zh: "选择此目录" },
				cancel: { en: "Cancel", zh: "取消" },
				createFailed: { en: "Could not create workspace", zh: "创建工作区失败" },
				tabDistros: { en: "Distros", zh: "发行版" },
				tabConfig: { en: "Config", zh: "配置" },
				tabRuntime: { en: "Runtime", zh: "运行态" },
				running: { en: "running", zh: "运行中" },
				stopped: { en: "stopped", zh: "已停止" },
				start: { en: "Start", zh: "启动" },
				stop: { en: "Stop", zh: "停止" },
				setDefault: { en: "Set default", zh: "设为默认" },
				setVersion: { en: "Switch to v", zh: "切到 v" },
				exportDistro: { en: "Export", zh: "导出" },
				exportPath: { en: "Export to a .tar path on Windows", zh: "导出到 Windows 上的 .tar 路径" },
				overwrite: { en: "Overwrite if the file exists", zh: "文件已存在时覆盖" },
				working: { en: "Working…", zh: "执行中…" },
				actionFailed: { en: "Command failed", zh: "命令失败" },
				scopeGlobal: { en: "Global .wslconfig", zh: "全局 .wslconfig" },
				scopeDistro: { en: "Distro /etc/wsl.conf", zh: "发行版 /etc/wsl.conf" },
				viewForm: { en: "Form", zh: "表单" },
				viewRaw: { en: "Raw text", zh: "原文" },
				save: { en: "Save", zh: "保存" },
				saved: { en: "Saved", zh: "已保存" },
				unset: { en: "(not set)", zh: "(未设置)" },
				needsRestart: { en: "Takes effect after WSL restarts.", zh: "需要重启 WSL 才生效。" },
				restartNow: { en: "Restart WSL now", zh: "立即重启 WSL" },
				later: { en: "Later", zh: "稍后" },
				confirmShutdownTitle: { en: "Restart WSL?", zh: "确认重启 WSL?" },
				confirmTitle: { en: "This cannot be undone", zh: "此操作不可撤销" },
				confirmRun: { en: "Run it", zh: "确认执行" },
				backupAt: { en: "Previous contents kept at", zh: "上一份内容已备份到" },
				unsupported: { en: "WSL only exists on Windows", zh: "WSL 只在 Windows 上存在" },
				unsupportedHint: {
					en: "This Harness is running on a platform without wsl.exe, so the page stays empty. Nothing failed.",
					zh: "当前 Harness 运行在没有 wsl.exe 的平台上，这个页面因此保持为空，并不是执行失败。"
				},
				confirmShutdownBody: {
					en: "wsl --shutdown stops every running distribution and every background task this plugin keeps.",
					zh: "wsl --shutdown 会终止所有正在运行的发行版，以及本插件保留的后台任务。"
				},
				confirmRestart: { en: "Restart", zh: "确认重启" },
				memory: { en: "Memory", zh: "内存" },
				disk: { en: "Disk", zh: "磁盘" },
				load: { en: "Load", zh: "负载" },
				uptime: { en: "Uptime", zh: "运行时长" },
				ports: { en: "Listening ports", zh: "监听端口" },
				processes: { en: "Processes", zh: "进程数" },
				wslStatus: { en: "wsl --status", zh: "wsl --status" },
				noConfig: { en: "The file does not exist yet; the first save creates it.", zh: "文件尚不存在，保存时创建。" },
				notRunningHint: { en: "Start the distro to see its numbers.", zh: "启动该发行版后才有这些数据。" },
				defBadge: { en: "default", zh: "默认" }
			};
			return (key) => ctx.locale.resolveText(text[key]);
		}

		const STYLE = {
			panel: { display: "flex", flexDirection: "column", height: "100%", padding: "12px", gap: "8px", overflow: "hidden" },
			header: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-color-text-primary, inherit)" },
			pickerTrigger: {
				display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px",
				width: "100%", padding: "4px 8px", fontSize: "12px", borderRadius: "6px",
				border: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.4))",
				background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.08))",
				color: "var(--dsw-alias-color-text-primary, inherit)", cursor: "pointer", textAlign: "left"
			},
			pickerList: {
				display: "flex", flexDirection: "column", gap: "2px", padding: "3px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.4))",
				background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.10))",
				maxHeight: "160px", overflowY: "auto"
			},
			// Options are real buttons with an explicit colour: a native <select> popup
			// is drawn by the OS and its hover line is unreadable on a dark theme.
			pickerOption: {
				width: "100%", padding: "3px 6px", fontSize: "12px", borderRadius: "4px", border: "none",
				background: "transparent", color: "var(--dsw-alias-color-text-primary, inherit)",
				cursor: "pointer", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
			},
			pickerOptionHover: { background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.22))" },
			pickerOptionActive: {
				background: "var(--dsw-alias-color-background-primary-button, rgba(127,127,127,.28))",
				color: "var(--dsw-alias-color-text-on-primary, var(--dsw-alias-color-text-primary, #fff))"
			},
			tabHover: { background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.14))", color: "var(--dsw-alias-color-text-primary, inherit)" },
			tabActiveHover: {
				background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.22))",
				color: "var(--dsw-alias-color-text-primary, inherit)"
			},
			miniHover: { background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.22))", color: "var(--dsw-alias-color-text-primary, inherit)" },
			buttonHover: { background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.18))", color: "var(--dsw-alias-color-text-primary, inherit)" },
			primaryHover: { filter: "brightness(1.12)" },
			breadcrumb: { fontSize: "11px", color: "var(--dsw-alias-color-text-secondary, rgba(127,127,127,1))", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			list: { flex: "1 1 auto", overflowY: "auto", border: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.25))", borderRadius: "8px", minHeight: "0" },
			row: {
				display: "flex", alignItems: "center", gap: "6px", width: "100%", padding: "5px 8px",
				fontSize: "12px", textAlign: "left", background: "none", border: "none",
				color: "inherit", cursor: "pointer"
			},
			rowFile: { ...{ display: "flex", alignItems: "center", gap: "6px", width: "100%", padding: "5px 8px", fontSize: "12px", textAlign: "left", background: "none", border: "none" }, color: "var(--dsw-alias-color-text-tertiary, rgba(127,127,127,.7))", cursor: "default" },
			footer: { display: "flex", gap: "8px" },
			button: {
				flex: "1 1 auto", padding: "6px 8px", fontSize: "12px", borderRadius: "8px", cursor: "pointer",
				border: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.4))",
				background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.08))",
				color: "inherit"
			},
			primary: { flex: "2 1 auto", padding: "6px 8px", fontSize: "12px", borderRadius: "8px", cursor: "pointer", border: "none", background: "var(--dsw-alias-color-background-primary-button, var(--dsw-alias-color-text-primary, #333))", color: "var(--dsw-alias-color-text-on-primary, #fff)" },
			hint: { fontSize: "11px", color: "var(--dsw-alias-color-text-tertiary, rgba(127,127,127,.7))" },
			tabBar: { display: "flex", gap: "4px", flexWrap: "wrap" },
			tab: {
				padding: "4px 10px", fontSize: "12px", borderRadius: "999px", cursor: "pointer",
				border: "1px solid transparent", background: "transparent",
				color: "var(--dsw-alias-color-text-secondary, rgba(127,127,127,1))"
			},
			tabActive: {
				padding: "4px 10px", fontSize: "12px", borderRadius: "999px", cursor: "pointer",
				border: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.4))",
				background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.12))",
				color: "var(--dsw-alias-color-text-primary, inherit)"
			},
			body: { flex: "1 1 auto", minHeight: "0", display: "flex", flexDirection: "column", gap: "8px" },
			card: {
				display: "flex", flexDirection: "column", gap: "4px", padding: "8px 10px", borderRadius: "8px",
				border: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.25))",
				background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.05))"
			},
			cardTitle: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 600 },
			cardRow: { display: "flex", justifyContent: "space-between", gap: "8px", fontSize: "11px" },
			dot: { width: "7px", height: "7px", borderRadius: "50%", flex: "0 0 auto" },
			badge: { fontSize: "10px", padding: "0 5px", borderRadius: "999px", border: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.4))", opacity: 0.85 },
			input: {
				width: "100%", padding: "3px 6px", fontSize: "12px", borderRadius: "6px",
				border: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.4))",
				background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.08))",
				color: "inherit"
			},
			field: { display: "grid", gridTemplateColumns: "1fr 1.1fr", alignItems: "center", gap: "6px", fontSize: "11px" },
			code: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "11px",
				whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text",
				maxHeight: "150px", overflowY: "auto"
			},
			bar: { height: "4px", borderRadius: "999px", background: "var(--dsw-alias-color-background-secondary, rgba(127,127,127,.25))", overflow: "hidden" },
			barFill: { height: "100%", borderRadius: "999px", background: "var(--dsw-alias-color-background-primary-button, #4a8)" },
			rowButtons: { display: "flex", gap: "4px", flexWrap: "wrap" },
			mini: {
				padding: "2px 7px", fontSize: "11px", borderRadius: "6px", cursor: "pointer",
				border: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.4))",
				background: "transparent", color: "inherit"
			},
			scroll: { flex: "1 1 auto", overflowY: "auto", minHeight: "0", display: "flex", flexDirection: "column", gap: "8px" }
		};

		const DISTRO_KEY = "wsl-sidebar.distro";

		/** The distro the panel last used, so several distributions stay distinguishable across restarts. */
		function rememberedDistro() {
			try {
				return window.localStorage.getItem(DISTRO_KEY) ?? "";
			} catch {
				return "";
			}
		}

		function rememberDistro(name) {
			try {
				window.localStorage.setItem(DISTRO_KEY, name);
			} catch {
				/* a panel must work without storage */
			}
		}

		function joinUnc(distro, segments) {
			return "\\\\wsl.localhost\\" + distro + (segments.length > 0 ? "\\" + segments.join("\\") : "");
		}

		/** Send a diagnostic line to the Host log; never throws. */
		function report(kind, detail) {
			try {
				fetch(LOG_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ kind, detail })
				}).catch(() => {});
			} catch {
				/* diagnostics must never break the panel */
			}
		}

		/**
		 * A button whose hover state is set inline. The panel is injected into
		 * someone else's stylesheet, so :hover cannot be relied on: the highlighted
		 * look is tracked in state and the colours are always explicit.
		 */
		function Btn({ style, hoverStyle, children, ...rest }) {
			const [hovered, setHovered] = React.useState(false);
			return h("button", {
				...rest,
				type: rest.type ?? "button",
				style: { ...style, ...(hovered && hoverStyle ? hoverStyle : null) },
				onMouseEnter: () => setHovered(true),
				onMouseLeave: () => setHovered(false)
			}, children);
		}

		/**
		 * A small select: a button that shows the current label and, while open, a
		 * list of buttons. Inline styles cannot express :hover, so the highlighted
		 * row is tracked in state and its colours are set explicitly.
		 */
		function Dropdown({ t, value, options, onChange, placeholder }) {
			const [open, setOpen] = React.useState(false);
			const [hovered, setHovered] = React.useState(-1);
			const current = options.find((option) => option.value === value);
			const label = current === undefined ? "" : current.label;
			return h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: "0" } },
				h("button", {
					type: "button", style: STYLE.pickerTrigger, title: label || placeholder || "",
					onClick: () => setOpen((was) => !was)
				},
				h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label.length > 0 ? label : placeholder ?? ""),
				h("span", { style: { opacity: 0.7, fontSize: "10px" } }, open ? "▲" : "▼")),
				open
					? h("div", { style: STYLE.pickerList }, options.map((option, index) => h("button", {
						key: option.value,
						type: "button",
						style: {
							...STYLE.pickerOption,
							...(index === hovered ? STYLE.pickerOptionHover : null),
							...(option.value === value ? STYLE.pickerOptionActive : null)
						},
						onMouseEnter: () => setHovered(index),
						onMouseLeave: () => setHovered(-1),
						onClick: () => {
							onChange(option.value);
							setOpen(false);
							setHovered(-1);
						}
					}, option.label)))
					: null);
		}

		// -- administration: distro lifecycle, configuration, runtime -----------

		const ADMIN = {
			distros: "/__wsl_plugin__/admin/distros",
			action: "/__wsl_plugin__/admin/action",
			config: "/__wsl_plugin__/admin/config",
			status: "/__wsl_plugin__/admin/status",
			platform: "/__wsl_plugin__/platform"
		};

		async function requestJson(url, init) {
			const response = await fetch(url, init);
			const text = await response.text();
			let data = null;
			try {
				data = text.length === 0 ? null : JSON.parse(text);
			} catch {
				data = null;
			}
			if (!response.ok) {
				const error = new Error(data?.message ?? data?.code ?? "HTTP " + response.status);
				error.status = response.status;
				error.data = data;
				throw error;
			}
			return data ?? {};
		}

		function postJson(url, body) {
			return requestJson(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {})
			});
		}

		/**
		 * Ask the Host whether WSL can exist here at all.
		 *
		 * `null` while asking. A failed or missing answer counts as "supported": that
		 * is what an older Host half looks like, and the tabs then report their own
		 * errors instead of the whole page claiming the wrong platform.
		 */
		function usePlatform() {
			const [platform, setPlatform] = React.useState(null);
			React.useEffect(() => {
				let alive = true;
				requestJson(ADMIN.platform).then((data) => {
					if (alive) setPlatform({ supported: data?.supported !== false, platform: String(data?.platform ?? "unknown") });
				}).catch((error) => {
					if (!alive) return;
					report("platform-check-failed", { message: String(error?.message ?? error) });
					setPlatform({ supported: true, platform: "unknown" });
				});
				return () => { alive = false; };
			}, []);
			return platform;
		}

		/** Human-readable byte size; the panel never shows raw byte counts outside a tooltip. */
		function formatBytes(bytes) {
			const value = Number(bytes);
			if (!Number.isFinite(value) || value <= 0) return "—";
			const units = ["B", "KB", "MB", "GB", "TB"];
			let size = value;
			let index = 0;
			while (size >= 1024 && index < units.length - 1) {
				size /= 1024;
				index += 1;
			}
			return (size >= 100 ? size.toFixed(0) : size.toFixed(1)) + " " + units[index];
		}

		function formatDuration(seconds) {
			const total = Math.max(0, Math.floor(Number(seconds) || 0));
			const days = Math.floor(total / 86400);
			const hours = Math.floor((total % 86400) / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			if (days > 0) return days + "d " + hours + "h";
			if (hours > 0) return hours + "h " + minutes + "m";
			return minutes + "m";
		}

		function UsageBar({ used, total }) {
			const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
			return h("div", { style: STYLE.bar, title: percent + "%" }, h("div", { style: { ...STYLE.barFill, width: percent + "%" } }));
		}

		/** Modal shell shared by the export and restart confirmations. */
		function Modal({ title, children, onClose }) {
			return h("div", {
				style: OVERLAY_STYLE,
				onClick: (event) => { if (event.target === event.currentTarget) onClose(); }
			}, h("div", { style: CARD_STYLE },
				h("div", { style: STYLE.header }, title),
				children));
		}

		function DistroTab({ ctx, t }) {
			const [rows, setRows] = React.useState(null);
			const [defaultName, setDefaultName] = React.useState(null);
			const [busy, setBusy] = React.useState(null);
			const [log, setLog] = React.useState(null);
			const [exportTarget, setExportTarget] = React.useState(null);
			const [exportPath, setExportPath] = React.useState("");
			const [exportOverwrite, setExportOverwrite] = React.useState(false);
			const [confirmAsk, setConfirmAsk] = React.useState(null);

			const load = React.useCallback(async () => {
				try {
					const data = await requestJson(ADMIN.distros);
					setRows(Array.isArray(data?.distros) ? data.distros : []);
					setDefaultName(typeof data?.default === "string" ? data.default : null);
				} catch (error) {
					report("admin-distros-failed", { message: String(error?.message ?? error) });
					setRows([]);
					setLog({ ok: false, text: String(error?.message ?? error) });
				}
			}, []);

			React.useEffect(() => {
				load();
			}, [load]);

			/**
			 * Run one panel action, and turn the Host's "ask first" answer into a modal.
			 *
			 * A deployment that does not run in danger-full-access refuses the
			 * irreversible actions until the request repeats itself with `acknowledge`;
			 * the confirm dialog below is what produces that second request.
			 */
			const perform = async (body) => {
				try {
					const data = await postJson(ADMIN.action, body);
					const text = (data?.command ?? body.action) + (data?.stdout ? "\n" + data.stdout : "") + (data?.stderr ? "\n" + data.stderr : "");
					setLog({ ok: data?.ok !== false, text });
					if (body.action === "export") setExportTarget(null);
				} catch (error) {
					if (error?.data?.code === "needs-acknowledge") {
						setConfirmAsk({ body, message: String(error.data.message ?? "") });
						return;
					}
					const detail = error?.data?.stderr || error?.data?.stdout || "";
					setLog({ ok: false, text: t("actionFailed") + ": " + String(error?.message ?? error) + (detail ? "\n" + detail : "") });
				} finally {
					setBusy(null);
					await load();
				}
			};

			const act = async (action, distro, extra) => {
				setBusy(action + ":" + (distro ?? ""));
				setLog(null);
				await perform({ action, distro, ...extra });
			};

			const startExport = async () => {
				if (exportTarget === null) return;
				setBusy("export:" + exportTarget);
				await perform({
					action: "export",
					distro: exportTarget,
					path: exportPath.trim(),
					overwrite: exportOverwrite,
					vhd: false
				});
			};

			return h("div", { style: STYLE.body },
				h("div", { style: STYLE.cardRow },
					h("span", { style: STYLE.hint }, rows === null ? t("loading") : (defaultName === null ? "" : t("defBadge") + ": " + defaultName)),
					h(Btn, { style: STYLE.mini, hoverStyle: STYLE.miniHover, onClick: load }, t("refresh"))),
				rows === null
					? h("div", { style: STYLE.hint }, t("loading"))
					: h("div", { style: STYLE.scroll }, rows.map((row) => {
						const running = row.state === "running";
						return h("div", { key: row.name, style: STYLE.card },
							h("div", { style: STYLE.cardTitle },
								h("span", { style: { ...STYLE.dot, background: running ? "var(--dsw-alias-color-status-success, #3a3)" : "var(--dsw-alias-color-text-tertiary, rgba(127,127,127,.6))" } }),
								h("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.name),
								h("span", { style: STYLE.badge }, "v" + row.version),
								row.isDefault ? h("span", { style: STYLE.badge }, t("defBadge")) : null),
							h("div", { style: STYLE.hint }, running ? t("running") : t("stopped")),
							h("div", { style: STYLE.rowButtons },
								running
									? h(Btn, { style: STYLE.mini, hoverStyle: STYLE.miniHover, disabled: busy !== null, onClick: () => act("terminate", row.name) }, busy === "terminate:" + row.name ? t("working") : t("stop"))
									: h(Btn, { style: STYLE.mini, hoverStyle: STYLE.miniHover, disabled: busy !== null, onClick: () => act("start", row.name) }, busy === "start:" + row.name ? t("working") : t("start")),
								row.isDefault
									? null
									: h(Btn, { style: STYLE.mini, hoverStyle: STYLE.miniHover, disabled: busy !== null, onClick: () => act("set-default", row.name) }, busy === "set-default:" + row.name ? t("working") : t("setDefault")),
								h(Btn, { style: STYLE.mini, hoverStyle: STYLE.miniHover, disabled: busy !== null, onClick: () => act("set-version", row.name, { version: row.version === 2 ? 1 : 2 }) }, t("setVersion") + (row.version === 2 ? "1" : "2")),
								h(Btn, { style: STYLE.mini, hoverStyle: STYLE.miniHover, disabled: busy !== null, onClick: () => { setExportTarget(row.name); setExportPath(""); setExportOverwrite(false); } }, t("exportDistro"))));
					})),
				log === null
					? null
					: h("div", {
						style: {
							...STYLE.code,
							color: log.ok ? "var(--dsw-alias-color-text-secondary, inherit)" : "var(--dsw-alias-color-status-danger, #c33)",
							borderTop: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.25))",
							paddingTop: "6px"
						}
					}, log.text),
				exportTarget === null
					? null
					: h(Modal, { title: t("exportDistro") + " · " + exportTarget, onClose: () => setExportTarget(null) },
						h("div", { style: STYLE.hint }, t("exportPath")),
						h("input", {
							style: STYLE.input,
							value: exportPath,
							placeholder: "D:\\backups\\" + exportTarget + ".tar",
							onChange: (event) => setExportPath(event.target.value)
						}),
						h("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "11px" } },
							h("input", { type: "checkbox", checked: exportOverwrite, onChange: (event) => setExportOverwrite(event.target.checked) }),
							t("overwrite")),
						h("div", { style: STYLE.footer },
							h(Btn, { style: STYLE.button, hoverStyle: STYLE.buttonHover, onClick: () => setExportTarget(null) }, t("cancel")),
							h(Btn, { style: STYLE.primary, hoverStyle: STYLE.primaryHover, disabled: exportPath.trim().length === 0 || busy !== null, onClick: startExport }, busy === "export:" + exportTarget ? t("working") : t("exportDistro")))),
				confirmAsk === null
					? null
					: h(Modal, { title: t("confirmTitle"), onClose: () => setConfirmAsk(null) },
						h("div", { style: STYLE.hint }, confirmAsk.message),
						h("div", { style: STYLE.footer },
							h(Btn, { style: STYLE.button, hoverStyle: STYLE.buttonHover, onClick: () => setConfirmAsk(null) }, t("cancel")),
							h(Btn, {
								style: STYLE.primary,
								hoverStyle: STYLE.primaryHover,
								onClick: () => {
									const ask = confirmAsk;
									setConfirmAsk(null);
									setBusy(ask.body.action + ":" + (ask.body.distro ?? ""));
									setLog(null);
									perform({ ...ask.body, acknowledge: ask.body.action });
								}
							}, t("confirmRun"))))
			);
		}

		function ConfigTab({ ctx, t }) {
			const [scope, setScope] = React.useState("global");
			const [distros, setDistros] = React.useState([]);
			const [distro, setDistro] = React.useState("");
			const [config, setConfig] = React.useState(null);
			const [view, setView] = React.useState("form");
			const [values, setValues] = React.useState({});
			const [draft, setDraft] = React.useState("");
			const [status, setStatus] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [askRestart, setAskRestart] = React.useState(false);

			React.useEffect(() => {
				let alive = true;
				requestJson(DISTROS_PATH).then((data) => {
					if (!alive) return;
					const list = Array.isArray(data?.distros) ? data.distros : [];
					setDistros(list);
					setDistro((current) => current && list.includes(current) ? current : list[0] ?? "");
				}).catch(() => { if (alive) setDistros([]); });
				return () => { alive = false; };
			}, []);

			const query = React.useCallback(() => {
				const params = new URLSearchParams({ scope });
				if (scope === "distro" && distro.length > 0) params.set("distro", distro);
				return params.toString();
			}, [scope, distro]);

			const adopt = React.useCallback((data) => {
				setConfig(data);
				const next = {};
				for (const field of data?.fields ?? []) next[field.section + "." + field.key] = field.present ? field.value : "";
				setValues(next);
				setDraft(typeof data?.text === "string" ? data.text : "");
			}, []);

			const load = React.useCallback(async () => {
				if (scope === "distro" && distro.length === 0) return;
				setStatus(null);
				try {
					adopt(await requestJson(ADMIN.config + "?" + query()));
				} catch (error) {
					report("admin-config-failed", { scope, distro, message: String(error?.message ?? error) });
					setStatus({ ok: false, text: String(error?.message ?? error) });
					setConfig(null);
				}
			}, [scope, distro, query, adopt]);

			React.useEffect(() => {
				load();
			}, [load]);

			const save = async () => {
				setBusy(true);
				setStatus(null);
				try {
					let data;
					if (view === "raw") {
						data = await postJson(ADMIN.config + "?" + query(), { mode: "raw", text: draft });
					} else {
						const edits = (config?.fields ?? []).map((field) => {
							const id = field.section + "." + field.key;
							const value = Object.prototype.hasOwnProperty.call(values, id) ? values[id] : field.value;
							return { section: field.section, key: field.key, value: value === "" ? null : value };
						});
						data = await postJson(ADMIN.config + "?" + query(), { mode: "fields", edits });
					}
					adopt(data);
					setStatus({
						ok: true,
						text: t("saved") + " · " + t("needsRestart") + (data?.backup ? "\n" + t("backupAt") + " " + data.backup : "")
					});
				} catch (error) {
					report("admin-config-save-failed", { scope, distro, message: String(error?.message ?? error) });
					setStatus({ ok: false, text: String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};

			const restart = async () => {
				setBusy(true);
				try {
					// The user reached this through the confirmation modal, so the request
					// carries the acknowledgement the Host asks for on restricted deployments.
					await postJson(ADMIN.action, { action: "shutdown", acknowledge: "shutdown" });
					setStatus({ ok: true, text: t("saved") + " · " + t("confirmShutdownTitle") + " ✓" });
					setAskRestart(false);
				} catch (error) {
					setStatus({ ok: false, text: String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};

			const control = (field) => {
				const id = field.section + "." + field.key;
				const value = Object.prototype.hasOwnProperty.call(values, id) ? values[id] : "";
				const onChange = (next) => setValues((current) => ({ ...current, [id]: next }));
				if (field.type === "bool" || field.type === "enum") {
					const options = field.type === "bool" ? ["true", "false"] : field.options ?? [];
					return h(Dropdown, {
						t,
						value,
						placeholder: t("unset"),
						options: [{ value: "", label: t("unset") }, ...options.map((option) => ({ value: option, label: option }))],
						onChange
					});
				}
				return h("input", {
					style: STYLE.input,
					value,
					placeholder: field.hint ?? "",
					inputMode: field.type === "number" ? "numeric" : "text",
					onChange: (event) => onChange(event.target.value)
				});
			};

			const sections = [];
			for (const field of config?.fields ?? []) {
				const block = sections.find((candidate) => candidate.name === field.section);
				if (block === undefined) sections.push({ name: field.section, fields: [field] });
				else block.fields.push(field);
			}

			return h("div", { style: STYLE.body },
				h("div", { style: STYLE.rowButtons },
					h(Btn, { style: scope === "global" ? STYLE.mini : STYLE.mini, hoverStyle: STYLE.miniHover, disabled: busy, onClick: () => setScope("global") },
						(scope === "global" ? "● " : "") + t("scopeGlobal")),
					h(Btn, { style: STYLE.mini, hoverStyle: STYLE.miniHover, disabled: busy, onClick: () => setScope("distro") },
						(scope === "distro" ? "● " : "") + t("scopeDistro"))),
				scope === "distro"
					? h("div", { style: STYLE.rowButtons }, distros.map((name) => h("button", {
						key: name,
						style: STYLE.mini,
						onClick: () => setDistro(name)
					}, (name === distro ? "● " : "") + name)))
					: null,
				config === null
					? h("div", { style: STYLE.hint }, status === null ? t("loading") : "")
					: h("div", { style: STYLE.card },
						h("div", { style: STYLE.cardRow },
							h("span", { style: { ...STYLE.hint, fontFamily: "ui-monospace, monospace" } }, config.path),
							h("span", { style: STYLE.hint }, config.exists ? t("saved") + "" : t("noConfig"))),
						h("div", { style: STYLE.rowButtons },
							h(Btn, { style: STYLE.mini, hoverStyle: STYLE.miniHover, onClick: () => setView("form") }, (view === "form" ? "● " : "") + t("viewForm")),
							h(Btn, { style: STYLE.mini, hoverStyle: STYLE.miniHover, onClick: () => setView("raw") }, (view === "raw" ? "● " : "") + t("viewRaw")))),
				config === null
					? null
					: h("div", { style: STYLE.scroll },
						view === "raw"
							? h("textarea", {
								style: { ...STYLE.input, minHeight: "220px", resize: "vertical", fontFamily: "ui-monospace, monospace" },
								value: draft,
								onChange: (event) => setDraft(event.target.value)
							})
							: sections.map((block) => h("div", { key: block.name, style: STYLE.card },
								h("div", { style: STYLE.cardTitle }, "[" + block.name + "]"),
								block.fields.map((field) => h("div", { key: field.section + field.key, style: STYLE.field },
									h("span", { title: field.section + "." + field.key }, ctx.locale.resolveText(field.label)),
									control(field)))))) ,
				status === null
					? null
					: h("div", {
						style: {
							...STYLE.hint,
							userSelect: "text",
							whiteSpace: "pre-wrap",
							color: status.ok ? "var(--dsw-alias-color-text-secondary, inherit)" : "var(--dsw-alias-color-status-danger, #c33)"
						}
					}, status.text),
				h("div", { style: STYLE.footer },
					h(Btn, { style: STYLE.primary, hoverStyle: STYLE.primaryHover, disabled: busy || config === null, onClick: save }, busy ? t("working") : t("save")),
					status === null || !status.ok
						? null
						: h(Btn, { style: STYLE.button, hoverStyle: STYLE.buttonHover, disabled: busy, onClick: () => setAskRestart(true) }, t("restartNow"))),
				askRestart
					? h(Modal, { title: t("confirmShutdownTitle"), onClose: () => setAskRestart(false) },
						h("div", { style: STYLE.hint }, t("confirmShutdownBody")),
						h("div", { style: STYLE.footer },
							h(Btn, { style: STYLE.button, hoverStyle: STYLE.buttonHover, onClick: () => setAskRestart(false) }, t("later")),
							h(Btn, { style: STYLE.primary, hoverStyle: STYLE.primaryHover, disabled: busy, onClick: restart }, t("confirmRestart"))))
					: null);
		}

		function RuntimeTab({ ctx, t }) {
			const [data, setData] = React.useState(null);
			const [error, setError] = React.useState(null);

			const load = React.useCallback(async () => {
				setError(null);
				try {
					setData(await requestJson(ADMIN.status));
				} catch (cause) {
					report("admin-status-failed", { message: String(cause?.message ?? cause) });
					setError(String(cause?.message ?? cause));
					setData(null);
				}
			}, []);

			React.useEffect(() => {
				load();
			}, [load]);

			const rows = Array.isArray(data?.distros) ? data.distros : [];

			return h("div", { style: STYLE.body },
				h("div", { style: STYLE.cardRow },
					h("span", { style: STYLE.hint }, data === null ? t("loading") : t("refresh") + " · " + rows.filter((row) => row.state === "running").length + "/" + rows.length),
					h(Btn, { style: STYLE.mini, hoverStyle: STYLE.miniHover, onClick: load }, t("refresh"))),
				error === null ? null : h("div", { style: { ...STYLE.hint, color: "var(--dsw-alias-color-status-danger, #c33)", userSelect: "text" } }, error),
				data?.wsl
					? h("div", { style: STYLE.card },
						h("div", { style: STYLE.cardTitle }, t("wslStatus")),
						h("div", { style: STYLE.code }, [data.wsl.status, data.wsl.version].filter((line) => typeof line === "string" && line.length > 0).join("\n")))
					: null,
				h("div", { style: STYLE.scroll }, rows.map((row) => {
					const stats = row.stats ?? null;
					const running = row.state === "running";
					return h("div", { key: row.name, style: STYLE.card },
						h("div", { style: STYLE.cardTitle },
							h("span", { style: { ...STYLE.dot, background: running ? "var(--dsw-alias-color-status-success, #3a3)" : "var(--dsw-alias-color-text-tertiary, rgba(127,127,127,.6))" } }),
							h("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.name),
							h("span", { style: STYLE.badge }, "v" + row.version),
							row.isDefault ? h("span", { style: STYLE.badge }, t("defBadge")) : null),
						stats === null
							? h("div", { style: STYLE.hint }, running ? t("loading") : t("notRunningHint"))
							: h("div", { style: { display: "flex", flexDirection: "column", gap: "5px" } },
								stats.memory
									? h("div", { style: { display: "flex", flexDirection: "column", gap: "3px" } },
										h("div", { style: STYLE.cardRow },
											h("span", null, t("memory")),
											h("span", { style: STYLE.hint }, formatBytes(stats.memory.usedBytes) + " / " + formatBytes(stats.memory.totalBytes))),
										h(UsageBar, { used: stats.memory.usedBytes, total: stats.memory.totalBytes }))
									: null,
								stats.disk
									? h("div", { style: { display: "flex", flexDirection: "column", gap: "3px" } },
										h("div", { style: STYLE.cardRow },
											h("span", null, t("disk")),
											h("span", { style: STYLE.hint }, formatBytes(stats.disk.usedBytes) + " / " + formatBytes(stats.disk.totalBytes) + (stats.disk.usedPercent ? " · " + stats.disk.usedPercent : ""))),
										h(UsageBar, { used: stats.disk.usedBytes, total: stats.disk.totalBytes }))
									: null,
								h("div", { style: STYLE.cardRow },
									h("span", null, t("load")),
									h("span", { style: STYLE.hint }, stats.load ?? "—")),
								h("div", { style: STYLE.cardRow },
									h("span", null, t("uptime")),
									h("span", { style: STYLE.hint }, stats.uptimeSeconds === null ? "—" : formatDuration(stats.uptimeSeconds))),
								h("div", { style: STYLE.cardRow },
									h("span", null, t("processes")),
									h("span", { style: STYLE.hint }, stats.processes === null ? "—" : String(stats.processes))),
								h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
									h("span", { style: STYLE.hint }, t("ports")),
									stats.ports.length === 0
										? h("span", { style: STYLE.hint }, "—")
										: h("span", { style: STYLE.code }, stats.ports.map((port) => port.address + ":" + port.port).join("  ")))));
				})));
		}

		function WslPanel(props) {
			const t = makeT(props.ctx);
			const platform = usePlatform();
			const [tab, setTab] = React.useState("distros");
			const tabs = [
				["distros", t("tabDistros")],
				["config", t("tabConfig")],
				["runtime", t("tabRuntime")]
			];
			if (platform !== null && platform.supported === false) {
				return h("div", { style: STYLE.panel },
					h("div", { style: STYLE.body },
						h("div", { style: STYLE.header }, t("unsupported")),
						h("div", { style: STYLE.hint }, t("unsupportedHint") + " (" + platform.platform + ")")));
			}
			return h("div", { style: STYLE.panel },
				h("div", { style: STYLE.tabBar, role: "tablist" }, tabs.map(([id, label]) => h(Btn, {
					key: id,
					type: "button",
					role: "tab",
					"aria-selected": tab === id,
					style: tab === id ? STYLE.tabActive : STYLE.tab,
					hoverStyle: tab === id ? STYLE.tabActiveHover : STYLE.tabHover,
					onClick: () => setTab(id)
				}, label))),
				tab === "distros"
					? h(DistroTab, { ctx: props.ctx, t })
					: tab === "config"
						? h(ConfigTab, { ctx: props.ctx, t })
						: h(RuntimeTab, { ctx: props.ctx, t }));
		}

		const OVERLAY_STYLE = {
			position: "fixed", inset: "0", zIndex: 2147483000,
			display: "flex", alignItems: "center", justifyContent: "center",
			background: "rgba(0,0,0,.35)"
		};

		const CARD_STYLE = {
			display: "flex", flexDirection: "column", gap: "8px",
			width: "min(460px, calc(100vw - 32px))", maxHeight: "min(560px, calc(100vh - 64px))",
			padding: "14px", borderRadius: "12px",
			border: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.4))",
			background: "var(--dsw-alias-color-background-elevated, var(--dsw-alias-color-background-secondary, #1f2023))",
			boxShadow: "0 16px 48px rgba(0,0,0,.35)",
			color: "var(--dsw-alias-color-text-primary, inherit)"
		};

		/** Distro + directory picker used by the new-session entry; shares the Host routes with the panel. */
		function WslDirDialog({ ctx, onClose }) {
			const t = makeT(ctx);
			const [distros, setDistros] = React.useState(null);
			const [distro, setDistro] = React.useState(rememberedDistro());
			const [segments, setSegments] = React.useState([]);
			const [entries, setEntries] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);

			React.useEffect(() => {
				let alive = true;
				fetch(DISTROS_PATH).then((r) => r.json()).then((data) => {
					if (!alive) return;
					const list = Array.isArray(data?.distros) ? data.distros : [];
					setDistros(list);
					setDistro((current) => current && list.includes(current) ? current : list[0] ?? "");
				}).catch((e) => {
					report("distros-failed", { where: "dialog", message: String(e?.message ?? e) });
					if (alive) setDistros([]);
				});
				return () => { alive = false; };
			}, []);

			React.useEffect(() => {
				if (!distro) return undefined;
				let alive = true;
				setEntries(null);
				setError(null);
				const rest = segments.map(encodeURIComponent).join("/");
				const url = LIST_PREFIX + "/" + encodeURIComponent(distro) + (rest ? "/" + rest : "");
				fetch(url)
					.then((r) => {
						if (!r.ok) throw new Error("HTTP " + r.status);
						return r.json();
					})
					.then((data) => {
						if (!alive) return;
						setEntries(Array.isArray(data?.entries) ? data.entries : []);
					})
					.catch((e) => {
						report("list-failed", { where: "dialog", distro, segments, message: String(e?.message ?? e) });
						if (!alive) return;
						setEntries([]);
						setError(String(e?.message ?? e));
					});
				return () => { alive = false; };
			}, [distro, segments]);

			const confirm = async () => {
				if (!distro || busy) return;
				setBusy(true);
				setError(null);
				const path = joinUnc(distro, segments);
				try {
					const created = await ctx.workspaces.create({ path });
					const workspaceId = created?.workspaceId
						?? created?.workspace?.workspaceId
						?? created?.value?.workspace?.workspaceId;
					if (!workspaceId) throw new Error("no workspaceId returned for " + path);
					report("hero-create", { path, workspaceId });
					await ctx.uiWorkspace.openWorkspace(workspaceId);
					onClose();
				} catch (e) {
					report("hero-create-failed", { path, message: String(e?.message ?? e) });
					setError(t("createFailed") + ": " + String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			};

			const dirs = (entries ?? []).filter((entry) => entry.dir);

			return h("div", {
				style: OVERLAY_STYLE,
				onClick: (event) => { if (event.target === event.currentTarget) onClose(); }
			}, h("div", { style: CARD_STYLE },
				h("div", { style: STYLE.header }, t("dialogTitle")),
				distros === null
					? h("div", { style: STYLE.hint }, t("loading"))
					: distros.length === 0
						? h("div", { style: STYLE.hint }, t("noDistros"))
						: h(Dropdown, {
							t,
							value: distro,
							placeholder: t("distro"),
							options: distros.map((name) => ({ value: name, label: name })),
							onChange: (name) => { setDistro(name); rememberDistro(name); setSegments([]); }
						}),
				distro ? h("div", { style: STYLE.breadcrumb }, "\\\\wsl.localhost\\" + distro + (segments.length ? "\\" + segments.join("\\") : "\\")) : null,
				distro ? h("div", { style: { ...STYLE.list, flex: "1 1 auto", minHeight: "180px" } },
					segments.length > 0
						? h("button", { style: STYLE.row, onClick: () => setSegments(segments.slice(0, -1)), title: t("goUp") }, "… ", t("goUp"))
						: null,
					entries === null
						? h("div", { style: STYLE.rowFile }, t("loading"))
						: dirs.length === 0
							? h("div", { style: STYLE.rowFile }, t("empty"))
							: dirs.map((entry) => h("button", {
								key: entry.name, style: STYLE.row,
								onClick: () => setSegments([...segments, entry.name])
							}, "📁 " + entry.name)))
					: null,
				error ? h("div", { style: { ...STYLE.hint, color: "var(--dsw-alias-color-status-danger, #c33)", userSelect: "text", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "120px", overflowY: "auto" } }, String(error)) : null,
				h("div", { style: STYLE.footer },
					h(Btn, { style: STYLE.button, hoverStyle: STYLE.buttonHover, onClick: onClose }, t("cancel")),
					h(Btn, { style: STYLE.primary, hoverStyle: STYLE.primaryHover, onClick: confirm, disabled: !distro || busy }, busy ? t("opening") : t("pick")))
			));
		}

		/** Compact entry in the new-session hero: pick a WSL folder instead of a Windows folder. */
		function WslHeroEntry({ ctx }) {
			const t = makeT(ctx);
			const platform = usePlatform();
			const [open, setOpen] = React.useState(false);
			if (platform !== null && platform.supported === false) return null;
			return h("div", { style: { display: "inline-flex" } },
				h("button", {
					type: "button",
					onClick: () => setOpen(true),
					title: t("dialogTitle"),
					style: {
						padding: "4px 10px", fontSize: "12px", borderRadius: "999px", cursor: "pointer",
						border: "1px solid var(--dsw-alias-color-border, rgba(127,127,127,.4))",
						background: "transparent",
						color: "var(--dsw-alias-color-text-secondary, inherit)"
					}
				}, "🐧 " + t("heroEntry")),
				open ? h(WslDirDialog, { ctx, onClose: () => setOpen(false) }) : null);
		}

		return {
			inject: ["slots", "locale", "workspaces", "uiWorkspace"],
			apply(ctx) {
				/* Settings → WSL: one page in the settings list, not a sidebar panel. */
				ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: PANEL_ID,
					order: 80,
					label: () => makeT(ctx)("panel"),
					locale: NS
				}, (props) => h(WslPanel, { ...props, ctx }))));
				ctx.effect(() => {
					try {
						return ctx.slots.inject("conversation.hero.options", () => ctx.slots.register({
							name: "conversation.hero.options",
							id: "wsl-dir",
							order: 60,
							label: "WSL",
							locale: NS
						}, () => h(WslHeroEntry, { ctx })));
					} catch (error) {
						report("hero-register-failed", { message: String(error?.message ?? error) });
						return undefined;
					}
				});
			}
		};
	}
});
