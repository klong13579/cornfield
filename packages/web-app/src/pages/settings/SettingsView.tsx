import { useState } from "react";
import { DEFAULT_SERVE_CONFIG } from "../../state/pi-client-adapter";
import { useSessionStore } from "../../state/session-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";

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
	const [appKey, setAppKey] = useState("");
	const [appSecret, setAppSecret] = useState("");

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
									className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-hairline-strong"
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
									className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-hairline-strong"
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
					</div>
				</section>

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
							desc="通知通道待后端（缺口 B7）"
							on={false}
							onToggle={() => undefined}
							disabled
						/>
						<ToggleRow
							label="出错告警"
							desc="通知通道待后端（缺口 B7）"
							on={false}
							onToggle={() => undefined}
							disabled
						/>
						<ToggleRow
							label="定时任务"
							desc="通知通道待后端（缺口 B7）"
							on={false}
							onToggle={() => undefined}
							disabled
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
										className="rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-hairline-strong"
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
										className="rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-hairline-strong"
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
