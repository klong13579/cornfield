import { ChevronDown, Cpu, Mic, Paperclip, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ContextRing } from "../../components/ContextRing";
import type { ImageContentDto } from "../../lib/wire-dto";
import { useSessionStore } from "../../state/session-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { DEFAULT_COMMANDS, filterSlashCommands, type SlashCommandDef, SlashPalette } from "./SlashPalette";

const THINKING_LEVELS = ["off", "low", "medium", "high"];

function statusDot(s: string): string {
	if (s === "online") return "bg-success";
	if (s === "busy") return "bg-warning animate-pulse";
	return "bg-ink-faint";
}

function statusLabel(s: string): string {
	switch (s) {
		case "online":
			return "运行中";
		case "busy":
			return "执行中";
		case "idle":
			return "空闲";
		case "stopped":
			return "已停用";
		default:
			return "状态未知";
	}
}

/**
 * 工作台输入区（assistant-ui Composer 就绪前的原生实现，两行：textarea + 工具栏）。
 * - Enter 发送 / Shift+Enter 换行 / Esc 中止（streaming 时）；发送↔停止原位替换
 * - 草稿自动保留（localStorage）
 * - 工具栏：Agent 选择器（按工作区分组 + CODING/WORKER + 钉钉角标）、附件、语音、
 *   模型/thinking 下拉、发送/停止
 */
export function ComposerBar({ autoFocusDraft = "" }: { autoFocusDraft?: string }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const ui = useUiState();
	const navigate = useNavigate();
	const textRef = useRef<HTMLTextAreaElement>(null);
	const [agentId, setAgentId] = useState<string | undefined>(view.agents[0]?.id);
	const [showAgentMenu, setShowAgentMenu] = useState(false);
	const [showModelMenu, setShowModelMenu] = useState(false);
	const [modelList, setModelList] = useState<Array<{ id: string; provider: string }>>([]);
	const [slashOpen, setSlashOpen] = useState(false);
	const [slashIndex, setSlashIndex] = useState(0);
	const value = ui.draft || autoFocusDraft;
	const [attachments, setAttachments] = useState<ImageContentDto[]>([]);
	const fileRef = useRef<HTMLInputElement>(null);

	// 附件：文件选择 → base64 读入 → prompt.images 通道（真命令已支持）
	const onPickImages = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		e.target.value = "";
		for (const file of files) {
			const reader = new FileReader();
			reader.onload = () => {
				const data = String(reader.result ?? "").split(",")[1] ?? "";
				if (data) {
					setAttachments(prev => [...prev, { type: "image", data, mimeType: file.type || "image/png" }]);
				}
			};
			reader.readAsDataURL(file);
		}
	};

	// 拉取真实可用模型列表（serve get_available_models；连接就绪后重拉，未连接/失败时保持空）
	useEffect(() => {
		if (!view.connected) return; // 未连接时跳过，连接后就绪再拉
		let cancelled = false;
		void store
			.getAvailableModels()
			.then(models => {
				if (!cancelled && models.length > 0) {
					setModelList(models.map(m => ({ id: m.id, provider: m.provider ?? "" })));
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [store, view.connected]);

	const active = view.isStreaming || view.phase !== "idle";
	const agent = view.agents.find(a => a.id === agentId) ?? view.agents[0];
	const workspaces = Array.from(new Set(view.agents.map(a => a.workspace).filter(Boolean)));

	useEffect(() => {
		if (autoFocusDraft) textRef.current?.focus();
	}, [autoFocusDraft]);

	const autoGrow = () => {
		const el = textRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
	};

	const send = () => {
		const text = value.trim();
		if (!text) return;
		getUiStore().setDraft("");
		store.prompt(text, agentId, attachments.length > 0 ? attachments : undefined);
		setAttachments([]);
	};

	const selectSlash = (cmd: SlashCommandDef) => {
		getUiStore().setDraft(`${cmd.name} `);
		setSlashOpen(false);
		textRef.current?.focus();
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (slashOpen) {
			const filtered = filterSlashCommands(DEFAULT_COMMANDS, value.slice(1));
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSlashIndex(i => Math.min(i + 1, filtered.length - 1));
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSlashIndex(i => Math.max(i - 1, 0));
				return;
			}
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				const cmd = filtered[slashIndex];
				if (cmd) selectSlash(cmd);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setSlashOpen(false);
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (active) {
				store.abort();
			} else {
				send();
			}
		} else if (e.key === "Escape" && active) {
			store.abort();
		}
	};

	return (
		<div className="shrink-0 border-t border-hairline bg-surface px-4.5 pt-3.5 pb-3">
			<div className="relative mx-auto max-w-[800px]">
				{slashOpen && (
					<SlashPalette
						query={value.slice(1)}
						activeIndex={slashIndex}
						onSelect={selectSlash}
						onHover={setSlashIndex}
					/>
				)}

				<div className="rounded-xl border border-hairline bg-surface-2 transition-[border-color,box-shadow] duration-150 focus-within:border-hairline-strong focus-within:shadow-[0_0_0_3px_var(--color-accent-dim)]">
					<textarea
						ref={textRef}
						rows={1}
						value={value}
						placeholder={`@${agent?.name ?? "Agent"} 发消息，或直接提问…`}
						onChange={e => {
							const v = e.target.value;
							getUiStore().setDraft(v);
							setSlashOpen(v.startsWith("/"));
							setSlashIndex(0);
						}}
						onInput={autoGrow}
						onKeyDown={onKeyDown}
						className="min-h-[52px] w-full resize-none border-none bg-transparent px-3.5 pt-3 pb-1.5 font-inherit text-ink outline-none placeholder:text-ink-faint"
					/>
					<div className="flex items-center gap-2 px-2.5 pb-1.5">
						{/* Agent 选择器 */}
						<div className="relative">
							<button
								type="button"
								className="flex items-center gap-2 rounded-md border border-hairline bg-surface-3 py-1 pr-2 pl-1 text-[12px] transition-colors hover:border-hairline-strong"
								onClick={() => setShowAgentMenu(v => !v)}
							>
								<span className="relative flex h-6 w-6 items-center justify-center rounded-[6px] border border-hairline bg-surface-2 text-[10px] font-semibold text-ink">
									{agent?.face ?? "?"}
									{agent?.dingtalkBound && (
										<span
											className="absolute -right-1 -bottom-1 flex h-3 w-3 items-center justify-center rounded-[4px] bg-dingtalk"
											title="钉钉绑定"
										/>
									)}
								</span>
								<span className="font-medium text-ink">@{agent?.name ?? "Agent"}</span>
								<ChevronDown size={11} strokeWidth={1.5} className="text-ink-faint" />
							</button>
							{showAgentMenu && (
								<div className="absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-65 overflow-hidden rounded-md border border-hairline-strong bg-surface shadow-lg">
									{workspaces.map(ws => (
										<div key={ws}>
											<div className="border-b border-hairline px-3 py-2 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
												{ws}
											</div>
											{view.agents
												.filter(a => a.workspace === ws)
												.map(a => (
													<button
														key={a.id}
														type="button"
														className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-3 ${a.id === agentId ? "bg-accent-dim" : ""}`}
														onClick={() => {
															setAgentId(a.id);
															store.attach(a.id); // lazy attach（幂等）
															store.switchSession(a.id); // 切 active：后续 prompt 默认发往该 agent
															setShowAgentMenu(false);
														}}
													>
														<span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-surface-2 text-[9px] font-semibold">
															{a.face}
														</span>
														<span className="min-w-0 flex-1">
															<span className="flex items-center gap-1.5 text-ink">
																@{a.name}
																<span
																	className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(a.status)}`}
																	title={statusLabel(a.status)}
																/>
															</span>
															<span className="text-[10px] text-ink-faint">
																{a.skillsCount ?? 0} 技能 · {a.cronCount ?? 0} 定时
															</span>
														</span>
														<span className="ml-auto shrink-0 text-[10px] text-ink-faint">
															{a.kind === "coding" ? "CODING" : "WORKER"}
														</span>
													</button>
												))}
										</div>
									))}
								</div>
							)}
						</div>

						<span className="h-[18px] w-px bg-hairline" />
						<input
							ref={fileRef}
							type="file"
							accept="image/*"
							multiple
							className="hidden"
							onChange={onPickImages}
						/>
						<button
							type="button"
							className="cbtn shrink-0"
							title={
								attachments.length > 0
									? `${attachments.length} 张图片已附加（发送时随指令）`
									: "添加图片（随指令发送）"
							}
							onClick={() => fileRef.current?.click()}
						>
							<Paperclip size={15} strokeWidth={1.5} />
							<span className="hidden sm:inline">附件</span>
							{attachments.length > 0 && (
								<span className="rounded bg-accent px-1 font-mono text-[10px] text-on-accent">
									{attachments.length}
								</span>
							)}
						</button>
						<button type="button" className="cbtn" title="语音输入" onClick={() => navigate("/voice")}>
							<Mic size={15} strokeWidth={1.5} />
						</button>

						<div className="flex-1" />

						{/* 模型 + thinking 下拉 */}
						<div className="relative">
							<button type="button" className="cbtn" onClick={() => setShowModelMenu(v => !v)}>
								<Cpu size={15} strokeWidth={1.5} />
								<b className="font-mono text-[12px] font-medium text-ink">{view.model ?? "—"}</b>
								<span className="rounded-[4px] bg-surface-3 px-1.5 py-px font-mono text-[10px] text-ink-subtle">
									{view.thinkingLevel ?? "off"}
								</span>
								<ChevronDown size={11} strokeWidth={1.5} className="text-ink-faint" />
							</button>
							{showModelMenu && (
								<div className="absolute right-0 bottom-[calc(100%+8px)] z-30 min-w-60 overflow-hidden rounded-md border border-hairline-strong bg-surface p-1 shadow-lg">
									<div className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
										模型
									</div>
									{modelList.length === 0 ? (
										<div className="px-2.5 py-2 text-[12px] text-ink-faint">
											无可用模型（未连接 / 列表加载中）
										</div>
									) : (
										modelList.map(m => (
											<button
												key={`${m.provider}/${m.id}`}
												type="button"
												className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left font-mono text-[13px] transition-colors hover:bg-surface-3 ${m.id === view.model ? "bg-accent-dim" : ""}`}
												onClick={() => {
													store.setModel(m.id, m.provider);
													setShowModelMenu(false);
												}}
											>
												{m.id}
												<span className="ml-auto font-sans text-[10px] text-ink-faint">{m.provider}</span>
											</button>
										))
									)}
									<div className="mt-1.5 px-2.5 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
										思维级别
									</div>
									{THINKING_LEVELS.map(level => (
										<button
											key={level}
											type="button"
											className={`flex w-full items-center rounded px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-3 ${level === view.thinkingLevel ? "bg-accent-dim" : ""}`}
											onClick={() => {
												store.setThinkingLevel(level);
												setShowModelMenu(false);
											}}
										>
											{level}
										</button>
									))}
								</div>
							)}
						</div>

						<span className="h-[18px] w-px bg-hairline" />

						{view.context && (
							<ContextRing
								percent={view.context.percent}
								usedTokens={view.context.usedTokens}
								totalTokens={view.context.totalTokens}
								size={28}
							/>
						)}
						{/* 发送 ↔ 停止 原位替换 */}
						<button
							type="button"
							onClick={() => (active ? store.abort() : send())}
							className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-none transition-colors ${active ? "bg-danger text-white hover:bg-danger/85" : "bg-accent text-on-accent hover:bg-accent-hover"}`}
							aria-label={active ? "停止" : "发送"}
						>
							{active ? (
								<Square size={14} strokeWidth={1.5} fill="currentColor" />
							) : (
								<Send size={14} strokeWidth={1.5} />
							)}
						</button>
					</div>
				</div>
				<div className="mt-1.5 flex gap-3.5 text-[11px] text-ink-faint">
					<span>
						<span className="kbd">Enter</span> 发送 · <span className="kbd">Shift+Enter</span> 换行 ·{" "}
						<span className="kbd">Esc</span> 中止
					</span>
					<span>draft 自动保留 · 输入自适应增高</span>
				</div>
			</div>
		</div>
	);
}
