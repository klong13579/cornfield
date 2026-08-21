import { useEffect, useState } from "react";
import { ensureNotifyPermission, loadNotifyPrefs, type NotifyPrefs, saveNotifyPrefs } from "../../lib/notifications";
import type { McpServerDto } from "../../lib/pi-client-api";
import { DEFAULT_SERVE_CONFIG } from "../../state/pi-client-adapter";
import { useSessionStore } from "../../state/session-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";

/** Electron 壳 preload bridge（T1 desktop 壳暴露的最小面：window.api.sidecar.setWorkspaceDir + app.getVersion）。
 * 网页直开（无 window.api）时工作目录降级存 localStorage，版本显示「—」，不 crash。
 * 契约与 packages/desktop/src/preload.ts 保持一致；字段均防御式存在性判断。 */
interface SidecarBridge {
	setWorkspaceDir: (dir: string) => Promise<unknown> | unknown;
}

/** Desktop 壳暴露到 window.api 的全部面（当前仅 sidecar + app 版本 + 更新流）。 */
interface DesktopBridgeApi {
	sidecar?: SidecarBridge;
	app?: {
		getVersion: () => Promise<string> | string;
		onUpdateAvailable: (cb: () => void) => () => void;
		onUpdateProgress: (cb: (p: { percent: number; bytesPerSecond: number }) => void) => () => void;
		onUpdateDownloaded: (cb: () => void) => () => void;
		downloadUpdate: () => Promise<{ ok: boolean; error?: string }>;
		installUpdate: () => void;
	};
}

/**
 * 设置页（FR-7）—— 连接信息（hello）/ 会话行为开关（set_auto_compaction / set_auto_retry）/
 * 主题 / 快捷键 / 连接配置 / 通知（缺口 B7 disabled）/ 钉钉集成（gateway 读占位）/ 危险操作（二次确认）。
 * 视觉主角：kbd 快捷键表。
 */
export function SettingsView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const ui = useUiState();
	const [wsUrl, setWsUrl] = useState(view.wsUrl);
	const [token, setToken] = useState("");
	const [saveError, setSaveError] = useState<string | null>(null);
	/** 工作目录（desktop 壳 sidecar 的工作区；默认 ~/workspace）。 */
	const [workspaceDir, setWorkspaceDir] = useState(() => {
		const stored = localStorage.getItem("omp.desktop.workspace")?.trim();
		return stored || "~/workspace";
	});
	const [workspaceSaved, setWorkspaceSaved] = useState(false);
	const [workspaceError, setWorkspaceError] = useState<string | null>(null);
	/** 桌面壳版本（Electron app.getVersion；网页直开无 window.api 时为 null）。 */
	const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
	/** 新版本可用提示（desktop 壳 update-available 事件）。 */
	const [updateState, setUpdateState] = useState<"idle" | "available" | "downloading" | "downloaded" | "error">(
		"idle",
	);
	const [updateProgress, setUpdateProgress] = useState(0);
	const [updateError, setUpdateError] = useState<string | null>(null);
	const [notifyPrefs, setNotifyPrefs] = useState<NotifyPrefs>(loadNotifyPrefs);
	const [notifyPermDenied, setNotifyPermDenied] = useState(
		typeof Notification !== "undefined" && Notification.permission === "denied",
	);
	/** B7-1：开关 → localStorage + 权限（开启时请求）；拒绝后 desc 提示。 */
	const toggleNotify =
		(key: keyof NotifyPrefs) =>
		(v: boolean): void => {
			const next = { ...notifyPrefs, [key]: v };
			setNotifyPrefs(next);
			saveNotifyPrefs(next);
			if (v) {
				void ensureNotifyPermission().then(ok => {
					if (!ok) setNotifyPermDenied(true);
				});
			}
		};
	const saveConnection = async (): Promise<void> => {
		setSaveError(null);
		try {
			const url = wsUrl.trim() || DEFAULT_SERVE_CONFIG.wsUrl;
			if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
				setSaveError("WS URL 需以 ws:// 或 wss:// 开头");
				return;
			}
			await store.reconfigure({ wsUrl: url, token: token.trim() });
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : String(err));
		}
	};
	/** 保存工作目录：有 desktop 壳（window.api）时经 bridge 传 main；否则降级 localStorage 镜像（不 crash）。 */
	const saveWorkspaceDir = async (): Promise<void> => {
		setWorkspaceError(null);
		setWorkspaceSaved(false);
		const value = workspaceDir.trim() || "~/workspace";
		try {
			const api = (window as Window & { api?: DesktopBridgeApi }).api;
			if (api?.sidecar?.setWorkspaceDir) {
				await api.sidecar.setWorkspaceDir(value);
			}
			// 镜像到 localStorage（展示初值来源；无 window.api 时即降级存储路径）
			localStorage.setItem("omp.desktop.workspace", value);
			setWorkspaceSaved(true);
		} catch (err) {
			setWorkspaceError(err instanceof Error ? err.message : String(err));
		}
	};
	const [appKey, setAppKey] = useState("");
	const [appSecret, setAppSecret] = useState("");

	/** 用户点「下载更新」：触发 electron-updater downloadUpdate，进度走 onUpdateProgress。 */
	const startUpdateDownload = async (): Promise<void> => {
		const api = (window as typeof window & { api?: DesktopBridgeApi }).api;
		if (!api?.app?.downloadUpdate) return;
		setUpdateError(null);
		setUpdateState("downloading");
		const res = await api.app.downloadUpdate();
		if (!res.ok) {
			setUpdateError(res.error ?? "下载失败");
			setUpdateState("error");
		}
	};
	/** 用户点「重启更新」：quitAndInstall 立即重启应用完成安装。 */
	const installUpdateNow = (): void => {
		const api = (window as typeof window & { api?: DesktopBridgeApi }).api;
		api?.app?.installUpdate?.();
	};

	// 桌面壳版本 + 更新流：Electron 环境经 window.api.app 读；网页直开无 api → 静默不处理。
	useEffect(() => {
		const api = (window as typeof window & { api?: DesktopBridgeApi }).api;
		if (!api?.app?.getVersion) return;
		Promise.resolve(api.app.getVersion())
			.then(v => setDesktopVersion(String(v)))
			.catch(() => setDesktopVersion(null));
		const unsubAvailable = api.app.onUpdateAvailable?.(() => setUpdateState("available"));
		const unsubProgress = api.app.onUpdateProgress?.(p => {
			setUpdateState("downloading");
			setUpdateProgress(Math.round(p.percent));
		});
		const unsubDownloaded = api.app.onUpdateDownloaded?.(() => setUpdateState("downloaded"));
		return () => {
			unsubAvailable?.();
			unsubProgress?.();
			unsubDownloaded?.();
		};
	}, []);

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[720px]">
				<h1 className="mb-8 text-[32px] font-semibold tracking-[-0.8px] text-ink">设置</h1>

				<section className="mb-9">
					<GroupTitle title="连接" />
					<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
						<Row k="状态">
							<span className="flex items-center gap-1.5 text-[13px] text-success">
								<span className={`conn-dot ${view.reconnecting ? "reconnecting" : ""}`} />
								{view.reconnecting ? "重连中（指数退避）" : "connected"}
							</span>
						</Row>
						<Row k="Connection ID">
							<span className="font-mono text-[11px] text-ink">{view.connectionId ?? "—"}</span>
						</Row>
						<Row k="协议版本">
							<span className="font-mono text-[11px] text-ink">v{view.protocolVersion}</span>
						</Row>
						<Row k="桌面壳版本">
							<span className="font-mono text-[11px] text-ink">{desktopVersion ?? "—"}</span>
						</Row>
						{updateState !== "idle" && (
							<Row k="更新">
								<span className="flex items-center gap-2 text-[12px] font-medium text-accent">
									{updateState === "available" && (
										<button
											type="button"
											onClick={() => void startUpdateDownload()}
											className="rounded border border-accent px-2 py-0.5 text-[11px] font-medium hover:bg-accent-dim"
										>
											新版本可用 — 下载更新
										</button>
									)}
									{updateState === "downloading" && (
										<span className="flex items-center gap-2 text-[11px]">
											<span>下载中 {updateProgress}%</span>
											<span className="h-1 w-24 overflow-hidden rounded bg-accent-dim">
												<span
													className="block h-full bg-accent transition-all"
													style={{ width: `${updateProgress}%` }}
												/>
											</span>
										</span>
									)}
									{updateState === "downloaded" && (
										<button
											type="button"
											onClick={installUpdateNow}
											className="rounded border border-accent px-2 py-0.5 text-[11px] font-medium hover:bg-accent-dim"
										>
											重启更新
										</button>
									)}
									{updateState === "error" && (
										<span className="text-[11px] text-danger">更新下载失败：{updateError}</span>
									)}
								</span>
							</Row>
						)}
					</div>

					<div className="mt-2 divide-y divide-hairline rounded-lg border border-hairline bg-surface">
						<div className="px-4 py-2.5">
							<label className="block text-[12px] text-ink-subtle" htmlFor="conn-wsurl">
								WS URL
							</label>
							<div className="mt-1 flex gap-2">
								<input
									id="conn-wsurl"
									value={wsUrl}
									onChange={e => setWsUrl(e.target.value)}
									placeholder={DEFAULT_SERVE_CONFIG.wsUrl}
									className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
								/>
							</div>
						</div>
						<div className="px-4 py-2.5">
							<label className="block text-[12px] text-ink-subtle" htmlFor="conn-token">
								Token
							</label>
							<div className="mt-1 flex gap-2">
								<input
									id="conn-token"
									type="password"
									value={token}
									onChange={e => setToken(e.target.value)}
									placeholder="serve 启动时打印的 token"
									className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
								/>
								<button
									type="button"
									onClick={() => void saveConnection()}
									className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover"
								>
									保存并重连
								</button>
							</div>
							{saveError !== null && <div className="mt-1 text-[11px] text-danger">{saveError}</div>}
						</div>
						<div className="px-4 py-2.5">
							<label className="block text-[12px] text-ink-subtle" htmlFor="conn-workspace">
								工作目录
							</label>
							<div className="mt-1 flex gap-2">
								<input
									id="conn-workspace"
									value={workspaceDir}
									onChange={e => {
										setWorkspaceDir(e.target.value);
										setWorkspaceSaved(false);
									}}
									placeholder="~/workspace"
									className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
								/>
								<button
									type="button"
									onClick={() => void saveWorkspaceDir()}
									className="shrink-0 rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover"
								>
									保存
								</button>
							</div>
							{workspaceSaved && <div className="mt-1 text-[11px] text-success">已保存</div>}
							{workspaceError !== null && <div className="mt-1 text-[11px] text-danger">{workspaceError}</div>}
						</div>
					</div>
				</section>

				<McpServerSection />

				<section className="mb-9">
					<GroupTitle title="主题" />
					<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
						<Row k="颜色主题">
							<span className="flex gap-1.5">
								<span className="rounded bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent">
									亮色（V6）
								</span>
								<span
									className="rounded border border-hairline px-2.5 py-1 text-[12px] text-ink-faint"
									title="深色 token 待落地"
								>
									深色（TODO）
								</span>
							</span>
						</Row>
						<Row k="消息密度">
							<span className="text-[13px] text-ink">紧凑</span>
						</Row>
					</div>
				</section>

				<section className="mb-9">
					<GroupTitle title="快捷键" />
					<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
						{[
							["Enter", "发送"],
							["Shift+Enter", "换行"],
							["Esc", "中止（streaming 时）"],
							["Cmd+M", "切换模型（TODO）"],
						].map(([keys, desc]) => (
							<div key={keys} className="flex items-center justify-between px-4 py-2.5">
								<span className="text-[13px] text-ink-subtle">{desc}</span>
								<span className="font-mono text-[11px] text-ink">{keys}</span>
							</div>
						))}
					</div>
				</section>

				<section className="mb-9">
					<GroupTitle title="会话行为" />
					<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
						<ToggleRow
							label="自动压缩"
							desc="上下文超阈值时自动 compact"
							on={view.flags.autoCompaction}
							onToggle={v => store.setAutoCompaction(v)}
						/>
						<ToggleRow
							label="自动重试"
							desc="模型调用失败后按退避重试"
							on={view.flags.autoRetry}
							onToggle={v => store.setAutoRetry(v)}
						/>
						<ToggleRow
							label="草稿保留"
							desc="输入内容自动持久化，刷新不丢（真控制：关闭后草稿不再写入 localStorage）"
							on={ui.keepDraft}
							onToggle={v => getUiStore().setKeepDraft(v)}
						/>
					</div>
				</section>

				<section className="mb-9">
					<GroupTitle title="通知" />
					<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
						<ToggleRow
							label="Agent 完成"
							desc={
								notifyPermDenied
									? "浏览器已拒绝通知权限——请在站点设置中开启"
									: "页面不在前台时，回合结束发浏览器通知（Notification API）"
							}
							on={notifyPrefs.agentDone}
							onToggle={toggleNotify("agentDone")}
						/>
						<ToggleRow
							label="出错告警"
							desc={
								notifyPermDenied
									? "浏览器已拒绝通知权限——请在站点设置中开启"
									: "回合/命令/重试出错时提醒（页面不在前台才发）"
							}
							on={notifyPrefs.errors}
							onToggle={toggleNotify("errors")}
						/>
						<ToggleRow
							label="定时任务"
							desc={
								notifyPermDenied
									? "浏览器已拒绝通知权限——请在站点设置中开启"
									: "后台轮询 cron 执行日志（B6 只读），新运行完成时提醒（页面不在前台才发）"
							}
							on={notifyPrefs.cron}
							onToggle={toggleNotify("cron")}
						/>
					</div>
				</section>

				<section className="mb-9">
					<GroupTitle title="钉钉集成" />
					<div className="space-y-3">
						<div className="rounded-lg border border-hairline bg-surface p-4">
							<div className="flex items-center gap-3">
								<span className="flex h-6 w-6 items-center justify-center rounded-[6px] bg-dingtalk text-[10px] font-semibold text-white">
									钉
								</span>
								<span className="text-[13px] text-ink">连接器配置</span>
								<span className="ml-auto rounded text-[13px] text-ink-faint">未配置</span>
							</div>
							<div className="mt-3 grid grid-cols-2 gap-3">
								<label className="flex flex-col gap-1 text-[11px] text-ink-subtle">
									AppKey
									<input
										value={appKey}
										onChange={e => setAppKey(e.target.value)}
										disabled
										placeholder="（配置存本地 gateway.json，编辑待接入）"
										className="rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
									/>
								</label>
								<label className="flex flex-col gap-1 text-[11px] text-ink-subtle">
									AppSecret
									<input
										value={appSecret}
										onChange={e => setAppSecret(e.target.value)}
										disabled
										type="password"
										placeholder="••••••"
										className="rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
									/>
								</label>
							</div>
							<button
								type="button"
								className="btn btn-secondary btn-sm mt-3"
								disabled
								title="P3 gateway 只读状态代理接入"
							>
								测试连接（TODO）
							</button>
						</div>
					</div>
				</section>

				<section>
					<GroupTitle title="危险操作" />
					<div className="flex gap-3">
						<button
							type="button"
							className="btn btn-danger btn-sm"
							title="后端暂无会话删除命令：点击仅开启新会话，不会清除历史记录（缺口 B6）"
							onClick={() => {
								if (
									window.confirm("后端尚无会话删除命令 —— 此操作仅开启新会话，不会清除任何历史记录。继续？")
								) {
									store.newSession();
								}
							}}
						>
							清除会话记录
						</button>
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							disabled
							title="重置逻辑待定（曾为空动作，已禁用防误导）"
						>
							重置设置
						</button>
					</div>
				</section>
			</div>
		</div>
	);
}

function GroupTitle({ title }: { title: string }): React.JSX.Element {
	return <h2 className="mb-2.5 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">{title}</h2>;
}

function Row({ k, children }: { k: string; children: React.ReactNode }): React.JSX.Element {
	return (
		<div className="flex items-center justify-between px-4 py-2.5">
			<span className="text-[12px] text-ink-subtle">{k}</span>
			{children}
		</div>
	);
}

function ToggleRow({
	label,
	desc,
	on,
	onToggle,
	disabled = false,
}: {
	label: string;
	desc: string;
	on: boolean;
	onToggle: (v: boolean) => void;
	disabled?: boolean;
}): React.JSX.Element {
	return (
		<button
			type="button"
			className="flex w-full items-center gap-2 px-4 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
			onClick={() => onToggle(!on)}
			disabled={disabled}
		>
			<span className="min-w-0 flex-1">
				<span className="block text-[13px] text-ink">{label}</span>
				{desc && <span className="block text-[11px] text-ink-faint">{desc}</span>}
			</span>
			<span className={`toggle ${on ? "on" : ""}`} />
		</button>
	);
}

/**
 * MCP 服务器管理区（设置页「连接」下方）。
 * 列表：名称 + command/args 摘要 + 启停 toggle + 测试 + 编辑 + 删除；新增/编辑用单表单。
 * 契约命令（get_mcp_servers / set_mcp_server / remove_mcp_server / test_mcp_server）
 * 由 serve 端 m1 并行实现，本前端按字符串契约对接（见 PiClient 方法注释）。
 */
function McpServerSection(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [servers, setServers] = useState<McpServerDto[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyName, setBusyName] = useState<string | null>(null);
	const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

	// 新增/编辑表单（editName = null 表示新增；非 null 表示编辑该名服务器，允许改名）。
	const [formOpen, setFormOpen] = useState(false);
	const [editName, setEditName] = useState<string | null>(null);
	const [formName, setFormName] = useState("");
	const [formCommand, setFormCommand] = useState("");
	const [formArgs, setFormArgs] = useState("");
	const [formError, setFormError] = useState<string | null>(null);
	const [formBusy, setFormBusy] = useState(false);

	const refreshServers = async (): Promise<void> => {
		setLoading(true);
		setError(null);
		try {
			const { servers: list } = await store.getMcpServers();
			setServers(list);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		if (!view.connected) return;
		void refreshServers();
	}, [store, view.connected]);

	const toggleEnabled = async (name: string, enabled: boolean): Promise<void> => {
		if (busyName) return;
		setBusyName(name);
		try {
			await store.setMcpServer({ name, enabled });
			await refreshServers();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyName(null);
		}
	};

	const testServer = async (name: string): Promise<void> => {
		if (busyName) return;
		setBusyName(name);
		try {
			const result = await store.testMcpServer(name);
			setTestResults(prev => ({ ...prev, [name]: result }));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setTestResults(prev => ({ ...prev, [name]: { ok: false, message } }));
		} finally {
			setBusyName(null);
		}
	};

	const removeServer = async (name: string): Promise<void> => {
		if (busyName) return;
		if (!window.confirm(`删除 MCP 服务器「${name}」？`)) return;
		setBusyName(name);
		try {
			await store.removeMcpServer(name);
			await refreshServers();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyName(null);
		}
	};

	const openAdd = (): void => {
		setFormOpen(true);
		setEditName(null);
		setFormName("");
		setFormCommand("");
		setFormArgs("");
		setFormError(null);
	};

	const openEdit = (srv: McpServerDto): void => {
		setFormOpen(true);
		setEditName(srv.name);
		setFormName(srv.name);
		setFormCommand(srv.command);
		setFormArgs(quoteArgs(srv.args));
		setFormError(null);
	};

	const saveServer = async (): Promise<void> => {
		setFormError(null);
		const name = formName.trim();
		if (!name) {
			setFormError("名称不能为空");
			return;
		}
		const command = formCommand.trim();
		if (!command) {
			setFormError("command 不能为空");
			return;
		}
		let args: string[];
		try {
			args = splitArgs(formArgs);
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
			return;
		}
		if (name !== editName && servers.some(s => s.name === name)) {
			setFormError(`已存在同名服务器「${name}」`);
			return;
		}
		setFormBusy(true);
		try {
			if (editName !== null && editName !== name) {
				// 改名：set_mcp_server 只能按 name upsert，无法原地改名；先 upsert 新名（保留旧 enabled），再删旧名。
				const old = servers.find(s => s.name === editName);
				await store.setMcpServer({ name, command, args, ...(old ? { enabled: old.enabled } : {}) });
				await store.removeMcpServer(editName);
			} else {
				await store.setMcpServer({ name, command, args });
			}
			setFormOpen(false);
			setEditName(null);
			await refreshServers();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
		} finally {
			setFormBusy(false);
		}
	};

	return (
		<section className="mb-9">
			<div className="mb-2.5 flex items-center justify-between">
				<h2 className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">MCP 服务器</h2>
				<button
					type="button"
					onClick={openAdd}
					className="rounded border border-hairline bg-surface px-2 py-0.5 text-[11px] text-ink-subtle hover:border-hairline-strong hover:text-ink"
				>
					新增
				</button>
			</div>

			<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
				{!view.connected && (
					<div className="px-4 py-6 text-center text-[12px] text-ink-faint">未连接——MCP 服务器列表不可用</div>
				)}
				{view.connected && loading && servers.length === 0 && (
					<div className="px-4 py-6 text-center text-[12px] text-ink-faint">加载中…</div>
				)}
				{view.connected && !loading && error && (
					<div className="px-4 py-6 text-center text-[12px] text-danger">加载失败：{error}</div>
				)}
				{view.connected && !loading && !error && servers.length === 0 && (
					<div className="px-4 py-6 text-center text-[12px] text-ink-faint">
						暂无 MCP 服务器——点右上角「新增」添加
					</div>
				)}
				{servers.map(srv => (
					<div key={srv.name} className="px-4 py-3">
						<div className="flex items-center gap-2">
							<div className="min-w-0 flex-1">
								<div className="flex items-baseline gap-2">
									<span className="font-mono text-[13px] font-medium text-ink">{srv.name}</span>
									{!srv.enabled && <span className="text-[11px] text-ink-faint">已停用</span>}
								</div>
								<div
									className="mt-0.5 truncate font-mono text-[11px] text-ink-faint"
									title={formatMcpCommand(srv)}
								>
									{formatMcpCommand(srv) || "—"}
								</div>
							</div>
							<button
								type="button"
								onClick={() => void testServer(srv.name)}
								disabled={busyName === srv.name}
								className="rounded border border-hairline bg-surface-2 px-2 py-1 text-[11px] text-ink-subtle hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
							>
								{busyName === srv.name ? "测试中…" : "测试"}
							</button>
							<button
								type="button"
								onClick={() => openEdit(srv)}
								className="rounded border border-hairline bg-surface-2 px-2 py-1 text-[11px] text-ink-subtle hover:border-hairline-strong hover:text-ink"
							>
								编辑
							</button>
							<button
								type="button"
								onClick={() => void removeServer(srv.name)}
								disabled={busyName === srv.name}
								className="rounded border border-hairline bg-surface-2 px-2 py-1 text-[11px] text-danger hover:border-danger disabled:cursor-not-allowed disabled:opacity-60"
							>
								删除
							</button>
							<button
								type="button"
								onClick={() => void toggleEnabled(srv.name, !srv.enabled)}
								disabled={busyName === srv.name}
								aria-label={`${srv.name} 启停开关`}
								className="shrink-0 disabled:cursor-not-allowed disabled:opacity-60"
							>
								<span className={`toggle ${srv.enabled ? "on" : ""}`} />
							</button>
						</div>
						{testResults[srv.name] && (
							<div
								className={`mt-2 whitespace-pre-wrap break-all text-[11px] ${testResults[srv.name].ok ? "text-success" : "text-danger"}`}
							>
								{testResults[srv.name].message || (testResults[srv.name].ok ? "测试通过" : "测试失败")}
							</div>
						)}
					</div>
				))}
			</div>

			{formOpen && (
				<div className="mt-2 rounded-lg border border-hairline bg-surface p-4">
					<div className="text-[12px] font-semibold text-ink">
						{editName !== null ? `编辑「${editName}」` : "新增 MCP 服务器"}
					</div>
					<div className="mt-3 space-y-3">
						<label className="flex flex-col gap-1 text-[11px] text-ink-subtle">
							名称
							<input
								value={formName}
								onChange={e => setFormName(e.target.value)}
								placeholder="如 gitnexus"
								className="rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
							/>
						</label>
						<label className="flex flex-col gap-1 text-[11px] text-ink-subtle">
							Command
							<input
								value={formCommand}
								onChange={e => setFormCommand(e.target.value)}
								placeholder="如 node"
								className="rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
							/>
						</label>
						<label className="flex flex-col gap-1 text-[11px] text-ink-subtle">
							Args（可选）
							<input
								value={formArgs}
								onChange={e => setFormArgs(e.target.value)}
								placeholder="单行输入，空格分隔，支持引号/反斜杠转义"
								className="rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
							/>
							<div className="text-[10px] text-ink-faint">
								按 shell 词法拆分：空格/制表符分隔，双引号 "" 或单引号 '' 包裹含空格参数，反斜杠转义单个字符。
							</div>
						</label>
					</div>
					{formError && <div className="mt-2 text-[11px] text-danger">{formError}</div>}
					<div className="mt-3 flex gap-2">
						<button
							type="button"
							onClick={() => void saveServer()}
							disabled={formBusy}
							className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						>
							{formBusy ? "保存中…" : "保存"}
						</button>
						<button
							type="button"
							onClick={() => setFormOpen(false)}
							disabled={formBusy}
							className="btn btn-secondary btn-sm"
						>
							取消
						</button>
					</div>
				</div>
			)}
		</section>
	);
}

/**
 * args 单行输入 → string[]（shell 词法拆分）：
 * - 空格/制表符分隔；(未加引号的) 空 token 不产生空参
 * - 双引号 "..."：分组，内部支持 \ 转义（" 和 \）
 * - 单引号 '...'：分组，内部字面量
 * - 反引号外的 \ 转义下一个字符（\ 后必须跟字符）
 * 引号未闭合 / 反斜杠结尾 → 抛错，由表单展示。
 */
function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let hasToken = false;
	let i = 0;
	const n = input.length;
	while (i < n) {
		const ch = input[i];
		if (ch === " " || ch === "\t" || ch === "\n") {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
			i++;
			continue;
		}
		hasToken = true;
		if (ch === '"') {
			i++;
			while (i < n && input[i] !== '"') {
				if (input[i] === "\\" && i + 1 < n) i++;
				current += input[i];
				i++;
			}
			if (i >= n) throw new Error("args 双引号未闭合");
			i++;
		} else if (ch === "'") {
			i++;
			while (i < n && input[i] !== "'") {
				current += input[i];
				i++;
			}
			if (i >= n) throw new Error("args 单引号未闭合");
			i++;
		} else if (ch === "\\") {
			i++;
			if (i >= n) throw new Error("args 反斜杠结尾非法");
			current += input[i];
			i++;
		} else {
			current += ch;
			i++;
		}
	}
	if (hasToken) args.push(current);
	return args;
}

/** string[] → 单行可编辑文本（含空格/引号/反斜杠的参数用双引号包裹并转义，空参输出 ""）。
 */
function quoteArgs(args: string[]): string {
	return args
		.map(a => {
			if (a === "") return '""';
			return /[\s"'\\]/.test(a) ? `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : a;
		})
		.join(" ");
}

/** 命令摘要：command + 引号安全的 args 连接（列表与编辑表单共用）。 */
function formatMcpCommand(srv: McpServerDto): string {
	const args = quoteArgs(srv.args);
	return args ? `${srv.command} ${args}` : srv.command;
}
