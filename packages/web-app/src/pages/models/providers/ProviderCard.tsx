import type { ProviderDisconnectResultDto, ProviderOAuthStartDto, ProviderStatusDto } from "@cornfield/wire";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
	acquireDisconnectLock,
	disconnectInProgress,
	notifyMccDataChanged,
	releaseDisconnectLock,
	subscribeDisconnectLock,
} from "./mcc-sync";
import {
	credentialSummary,
	errorText,
	FORCE_ACK_LABEL,
	forceConfirmText,
	groupDependencies,
	isoToMinuteText,
	lastRefreshText,
	raceLockNotice,
	sessionModelWarning,
	statusBadge,
	statusHint,
} from "./provider-display";
import { useProviderStore } from "./provider-store";

/** 弱化文字按钮（次要动作；沿用 CatalogView 的 inline 样式语汇，不新造 CSS 类）。 */
const PLAIN_ACTION =
	"rounded px-1.5 py-0.5 text-[11.5px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";
/** 危险文字按钮（删除 Key / 断开）。 */
const DANGER_ACTION =
	"rounded px-1.5 py-0.5 text-[11.5px] text-ink-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40";

/**
 * 单个 Provider 的管理卡片（#03）：折叠态 = 状态行（六态徽章 + 凭据来源/掩码 + 模型数），
 * 展开态 = OAuth / API Key / 环境变量（只读）/ Base URL（本地端点）/ 目录元数据 / 断开。
 *
 * 交互契约：
 * - 所有写动作经 runAction 串行（pending 期间本卡按钮全禁用），失败经 onError 上抛页面 banner；
 * - OAuth：start 拿 authUrl/instructions/requiresManualCode；手输 code 走 complete，
 *   纯轮询流提示用户完成浏览器授权后手动「刷新状态」（get_provider）收口；
 * - API Key 输入框一律 type=password；保存成功后清空输入，列表仅回显 maskedKey；
 * - 断开：首次 force=false 拿依赖检查结果（未断开时展示依赖清单 + 替换引导），
 *   force 需勾选明示文案后二次确认；断开成功后通知壳层重拉数据（异常区随之更新）。
 * - 竞态：断开流程（检查面板打开至完成）期间持断开锁，其他 provider 的写操作禁用；
 *   写动作成功后经 notifyMccDataChanged 通知壳层重拉 providers/catalog/scope。
 */
export function ProviderCard({
	provider,
	onStatus,
	onError,
}: {
	provider: ProviderStatusDto;
	onStatus: (next: ProviderStatusDto) => void;
	onError: (message: string) => void;
}): React.JSX.Element {
	const store = useProviderStore();
	const [expanded, setExpanded] = useState(false);
	const [pending, setPending] = useState(false);

	// OAuth 流程态
	const [oauthStart, setOauthStart] = useState<ProviderOAuthStartDto | null>(null);
	const [oauthCode, setOauthCode] = useState("");

	// API Key 表单态（明文只存在于输入框受控状态，成功后清空）
	const [keyFormOpen, setKeyFormOpen] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [apiKeyConfirm, setApiKeyConfirm] = useState("");
	const [keyFormHint, setKeyFormHint] = useState<string | null>(null);

	// Base URL 草稿（保存/清除成功后显式同步，避免受控输入与权威态竞争）
	const [baseUrlDraft, setBaseUrlDraft] = useState(provider.baseUrl ?? "");

	// 断开依赖检查结果（force=false 未断开时的 dependencies 清单）
	const [disconnectCheck, setDisconnectCheck] = useState<ProviderDisconnectResultDto | null>(null);
	// force 勾选态（明示文案确认后才允许点击强制断开）
	const [forceAck, setForceAck] = useState(false);

	// 断开锁：任一 provider 断开流程进行中时，本卡写操作禁用（跨卡竞态防护）
	const lockHolder = useSyncExternalStore(subscribeDisconnectLock, disconnectInProgress);
	const otherLock = lockHolder !== null && lockHolder !== provider.providerId;
	// 本卡断开检查面板打开期间同样冻结本卡其他写操作（依赖清单与配置状态需保持一致）
	const writesBlocked = pending || otherLock || disconnectCheck !== null;
	const blockedTitle = otherLock && lockHolder ? raceLockNotice(lockHolder) : undefined;

	// 卸载时若仍持锁（面板开着直接离开页面）则释放；未持锁时为 no-op
	useEffect(() => () => releaseDisconnectLock(provider.providerId), [provider.providerId]);

	const badge = statusBadge(provider.status);
	const hint = statusHint(provider.status);
	const summary = credentialSummary(provider);
	// 会话占用警告：依赖清单含 session-model 时的醒目提示（断开后会话调用立即失败）
	const sessionWarn = disconnectCheck ? sessionModelWarning(disconnectCheck.dependencies) : null;
	const isLocal = provider.local === true;
	const reauthNeeded =
		provider.status === "oauth-expiring" ||
		(provider.status === "credential-invalid" && provider.credentialSource === "oauth");

	/** 串行动作包装：pending 互斥 + 失败上抛页面级 banner（可诊断错误，不静默）。 */
	const runAction = async (label: string, fn: () => Promise<void>): Promise<void> => {
		if (pending) return;
		setPending(true);
		try {
			await fn();
		} catch (err) {
			onError(`${label}失败：${errorText(err)}`);
		} finally {
			setPending(false);
		}
	};

	const closeOauthFlow = (): void => {
		setOauthStart(null);
		setOauthCode("");
	};

	const resetKeyForm = (): void => {
		setKeyFormOpen(false);
		setApiKey("");
		setApiKeyConfirm("");
		setKeyFormHint(null);
	};

	/** 保存 API Key：非空 + 两次输入一致才发请求；成功后清空输入并关闭表单（仅 maskedKey 回显）。 */
	const submitKey = (): void => {
		const key = apiKey.trim();
		if (!key) {
			setKeyFormHint("请输入 API Key");
			return;
		}
		if (key !== apiKeyConfirm.trim()) {
			setKeyFormHint("两次输入不一致");
			return;
		}
		setKeyFormHint(null);
		void runAction("保存 API Key", async () => {
			onStatus(await store.saveProviderApiKey(provider.providerId, key));
			notifyMccDataChanged();
			resetKeyForm();
		});
	};

	/**
	 * 进入断开流程：持断开锁后 force=false 拿依赖清单。持锁从点击断开起直至流程结束
	 * （断开完成 / 取消 / 失败）——面板打开期间其他 provider 的写操作全部禁用，避免
	 * 依赖清单与实际配置状态之间产生竞态。
	 */
	const beginDisconnect = (): void => {
		if (!acquireDisconnectLock(provider.providerId)) {
			onError(raceLockNotice(disconnectInProgress() ?? "其他 Provider"));
			return;
		}
		void runAction("断开 Provider", async () => {
			let result: ProviderDisconnectResultDto;
			try {
				result = await store.disconnectProvider(provider.providerId, false);
			} catch (err) {
				releaseDisconnectLock(provider.providerId);
				throw err;
			}
			if (result.disconnected) {
				releaseDisconnectLock(provider.providerId);
				onStatus(result.provider);
				notifyMccDataChanged();
			} else if (result.dependencies.length > 0) {
				setDisconnectCheck(result); // 面板打开期间继续持锁
			} else {
				releaseDisconnectLock(provider.providerId);
				onError("断开未执行且未返回依赖清单，请重试或检查 serve 日志");
			}
		});
	};

	/** 取消断开：重置面板与勾选态并释放锁。 */
	const cancelDisconnect = (): void => {
		setDisconnectCheck(null);
		setForceAck(false);
		releaseDisconnectLock(provider.providerId);
	};

	/**
	 * 强制断开：勾选明示文案 + window.confirm 二次确认后才发 force=true。
	 * 红线：断开不修改任何角色配置或会话模型——引用失效由壳层异常区以
	 * 失效待修复派生态展示，重新接入后自动恢复（无清理动作）。
	 */
	const forceDisconnect = (): void => {
		if (!disconnectCheck) return;
		if (!window.confirm(forceConfirmText(provider.providerId, disconnectCheck.dependencies))) return;
		void runAction("强制断开", async () => {
			const result = await store.disconnectProvider(provider.providerId, true);
			setDisconnectCheck(null);
			setForceAck(false);
			releaseDisconnectLock(provider.providerId);
			onStatus(result.provider);
			notifyMccDataChanged();
			if (!result.disconnected) onError("强制断开未生效（服务端未执行断开），请重试");
		});
	};

	return (
		<div className="overflow-hidden rounded-xl border border-hairline bg-surface">
			{/* 折叠态状态行 */}
			<div className="flex items-center gap-4 px-5 py-3.5">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-[14px] font-medium text-ink">
							{provider.displayName ?? provider.providerId}
						</span>
						{provider.displayName && provider.displayName !== provider.providerId && (
							<span className="font-mono text-[11px] text-ink-faint">{provider.providerId}</span>
						)}
						{isLocal && (
							<span className="badge info" title="本地 provider（ollama / lm-studio / llama.cpp 类）">
								本地
							</span>
						)}
						<span className={badge.className}>{badge.label}</span>
					</div>
					<div className="mt-0.5 truncate text-[12px] text-ink-subtle">{summary ?? "未配置凭据"}</div>
				</div>
				<span className="shrink-0 font-mono text-[11px] text-ink-faint" title="目录内模型数（全量，未按停用过滤）">
					{provider.modelCount} 模型
				</span>
				<button type="button" className="btn btn-sm shrink-0" onClick={() => setExpanded(v => !v)}>
					{expanded ? "收起" : "管理"}
				</button>
			</div>

			{expanded && (
				<div className="border-t border-hairline px-5 pb-1">
					{hint && (
						<div className="mt-4 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-[12px] text-warning">
							{hint}
						</div>
					)}

					{otherLock && lockHolder && (
						<div className="mt-4 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-[12px] text-warning">
							{raceLockNotice(lockHolder)}
						</div>
					)}

					{!isLocal && (
						<Section title="OAuth 登录">
							{oauthStart ? (
								<div>
									{oauthStart.instructions && (
										<p className="text-[12px] text-ink-subtle">{oauthStart.instructions}</p>
									)}
									{oauthStart.authUrl && (
										<div className="mt-2">
											<a className="btn btn-sm" href={oauthStart.authUrl} target="_blank" rel="noreferrer">
												打开授权页
											</a>
										</div>
									)}
									{oauthStart.requiresManualCode ? (
										<div className="mt-2 flex items-center gap-2">
											<input
												type="text"
												value={oauthCode}
												onChange={e => setOauthCode(e.target.value)}
												placeholder="粘贴授权 code"
												className="w-[280px] rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
											/>
											<button
												type="button"
												className="btn btn-sm"
												disabled={writesBlocked || !oauthCode.trim()}
												title={blockedTitle}
												onClick={() =>
													void runAction("提交授权 code", async () => {
														onStatus(
															await store.completeProviderOauth(provider.providerId, oauthCode.trim()),
														);
														notifyMccDataChanged();
														closeOauthFlow();
													})
												}
											>
												完成
											</button>
										</div>
									) : (
										<div className="mt-2 flex items-center gap-2">
											<span className="text-[12px] text-ink-subtle">在浏览器完成授权后，刷新状态收口。</span>
											<button
												type="button"
												className="btn btn-sm"
												disabled={writesBlocked}
												title={blockedTitle}
												onClick={() =>
													void runAction("刷新 Provider 状态", async () => {
														onStatus(await store.fetchProvider(provider.providerId));
													})
												}
											>
												刷新状态
											</button>
										</div>
									)}
									<button type="button" className={`${PLAIN_ACTION} mt-2`} onClick={closeOauthFlow}>
										取消
									</button>
								</div>
							) : (
								<div className="flex items-center gap-2">
									<button
										type="button"
										className="btn btn-sm"
										disabled={writesBlocked}
										title={blockedTitle}
										onClick={() =>
											void runAction("发起 OAuth 登录", async () => {
												setOauthStart(await store.startProviderOauth(provider.providerId));
											})
										}
									>
										{reauthNeeded ? "重新认证" : "发起 OAuth 登录"}
									</button>
									{provider.status === "oauth-expiring" && provider.oauthExpiresAt && (
										<span className="font-mono text-[11px] text-ink-faint">
											{isoToMinuteText(provider.oauthExpiresAt)} 过期
										</span>
									)}
								</div>
							)}
						</Section>
					)}

					{!isLocal && (
						<Section title="API Key">
							{provider.credentialSource === "api-key" && !keyFormOpen && (
								<div className="flex items-center gap-2">
									<span className="font-mono text-[12px] text-ink">{summary}</span>
									<button
										type="button"
										className={PLAIN_ACTION}
										disabled={writesBlocked}
										title={blockedTitle}
										onClick={() => setKeyFormOpen(true)}
									>
										替换
									</button>
									<button
										type="button"
										className={DANGER_ACTION}
										disabled={writesBlocked}
										title={blockedTitle}
										onClick={() =>
											void runAction("删除 API Key", async () => {
												onStatus(await store.deleteProviderApiKey(provider.providerId));
												notifyMccDataChanged();
											})
										}
									>
										删除
									</button>
								</div>
							)}
							{provider.credentialSource !== "api-key" && !keyFormOpen && (
								<button
									type="button"
									className="btn btn-sm"
									disabled={writesBlocked}
									title={blockedTitle}
									onClick={() => setKeyFormOpen(true)}
								>
									录入 API Key
								</button>
							)}
							{keyFormOpen && (
								<form
									className="mt-1"
									onSubmit={e => {
										e.preventDefault();
										submitKey();
									}}
								>
									<input
										type="password"
										value={apiKey}
										onChange={e => setApiKey(e.target.value)}
										placeholder="API Key"
										autoComplete="new-password"
										className="block w-[360px] rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
									/>
									<input
										type="password"
										value={apiKeyConfirm}
										onChange={e => setApiKeyConfirm(e.target.value)}
										placeholder="再次输入确认"
										autoComplete="new-password"
										className="mt-2 block w-[360px] rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
									/>
									{keyFormHint && <p className="mt-1.5 text-[12px] text-danger">{keyFormHint}</p>}
									{provider.credentialSource === "env" && (
										<p className="mt-1.5 text-[11px] text-ink-faint">保存后将优先于环境变量凭据使用。</p>
									)}
									<div className="mt-2 flex items-center gap-2">
										<button
											type="submit"
											className="btn btn-sm"
											disabled={writesBlocked}
											title={blockedTitle}
										>
											保存
										</button>
										<button type="button" className={PLAIN_ACTION} onClick={resetKeyForm}>
											取消
										</button>
									</div>
								</form>
							)}
						</Section>
					)}

					{(provider.envVarNames?.length || provider.credentialSource === "env") && (
						<Section title="环境变量凭据（只读）">
							{provider.envVarNames?.length ? (
								<>
									<div className="flex flex-wrap gap-1.5">
										{provider.envVarNames.map(name => (
											<span
												key={name}
												className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink"
											>
												{name}
											</span>
										))}
									</div>
									<p className="mt-1.5 text-[12px] text-ink-subtle">
										检测状态：{provider.envVarPresent ? "已设置" : "未检测到"}
									</p>
								</>
							) : (
								<p className="text-[12px] text-ink-subtle">凭据来自环境变量（变量名未由目录声明）。</p>
							)}
							<p className="text-[11px] text-ink-faint">在运行环境中配置，Web 不可覆写。</p>
						</Section>
					)}

					<Section title={isLocal ? "本地端点" : "Base URL"}>
						<div className="text-[12px] text-ink-subtle">
							当前：
							<span className="font-mono text-ink">{provider.baseUrl ?? "目录默认"}</span>
						</div>
						<div className="mt-2 flex items-center gap-2">
							<input
								type="text"
								value={baseUrlDraft}
								onChange={e => setBaseUrlDraft(e.target.value)}
								placeholder={isLocal ? "http://127.0.0.1:11434" : "https://…/v1"}
								className="w-[360px] rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
							/>
							<button
								type="button"
								className="btn btn-sm"
								disabled={
									writesBlocked || !baseUrlDraft.trim() || baseUrlDraft.trim() === (provider.baseUrl ?? "")
								}
								title={blockedTitle}
								onClick={() =>
									void runAction(`保存${isLocal ? "本地端点" : " Base URL"}`, async () => {
										onStatus(await store.setProviderBaseUrl(provider.providerId, baseUrlDraft.trim()));
										notifyMccDataChanged();
									})
								}
							>
								保存
							</button>
							{provider.baseUrl && (
								<button
									type="button"
									className={PLAIN_ACTION}
									disabled={writesBlocked}
									title={blockedTitle}
									onClick={() =>
										void runAction(`清除${isLocal ? "本地端点" : " Base URL"}`, async () => {
											onStatus(await store.setProviderBaseUrl(provider.providerId, null));
											notifyMccDataChanged();
											setBaseUrlDraft("");
										})
									}
								>
									清除恢复默认
								</button>
							)}
						</div>
						<p className="text-[11px] text-ink-faint">
							{isLocal
								? "指向本机服务端点；离线与凭据错误以状态徽章区分。"
								: "覆盖目录默认端点（兼容/自建网关）。"}
						</p>
					</Section>

					<Section title="目录元数据">
						<div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-subtle">
							<span>上次刷新：{lastRefreshText(provider.lastRefreshAt)}</span>
							{provider.catalogStale && (
								<span className="badge run" title="目录数据非权威（缓存/回落来源），可在目录刷新后更新">
									目录非权威
								</span>
							)}
							<button
								type="button"
								className={PLAIN_ACTION}
								disabled={writesBlocked}
								title={blockedTitle ?? "强制 online 刷新该 Provider 目录（绕过缓存 TTL；不影响其他 Provider）"}
								onClick={() =>
									void runAction("刷新目录", async () => {
										onStatus(await store.refreshProvider(provider.providerId));
										notifyMccDataChanged();
									})
								}
							>
								刷新目录
							</button>
						</div>
					</Section>

					<Section title="断开">
						{disconnectCheck ? (
							<div className="rounded-lg border border-danger/40 bg-danger/5 p-3">
								{/* 醒目警告：当前会话正在使用该 provider 的模型（session-model 依赖） */}
								{sessionWarn && (
									<div className="rounded border border-danger/60 bg-danger/10 px-3 py-2 text-[12px] font-medium text-danger">
										{sessionWarn}
										<Link
											to="/models/catalog"
											className="ml-1.5 shrink-0 font-medium text-danger underline underline-offset-2"
										>
											去模型目录切换
										</Link>
									</div>
								)}
								<p className="text-[12px] text-danger">
									该 Provider 的模型仍被以下配置引用，断开后引用不会自动切换、也不会被自动改写：
								</p>
								{groupDependencies(disconnectCheck.dependencies).map(group => (
									<div key={group.kind} className="mt-2">
										<div className="text-[11px] font-medium text-ink">
											{group.label}（{group.items.length}）
										</div>
										{group.items.map(dep => (
											<div
												key={`${dep.kind}:${dep.ref}:${dep.model}`}
												className="font-mono text-[11px] text-ink-subtle"
											>
												{dep.ref} → {dep.model}
											</div>
										))}
										{group.kind !== "session-model" && (
											<Link
												to="/models/config"
												className="mt-0.5 inline-block text-[11px] font-medium text-accent underline underline-offset-2"
											>
												为{group.label}选择替代模型 → 运行时配置
											</Link>
										)}
									</div>
								))}
								{/* force 明示勾选：不改配置 + 失效待修复语义，勾选后才可进入二次确认 */}
								<label className="mt-3 flex cursor-pointer items-start gap-2 text-[12px] text-ink">
									<input
										type="checkbox"
										checked={forceAck}
										onChange={e => setForceAck(e.target.checked)}
										className="mt-0.5 shrink-0 accent-[var(--color-danger)]"
									/>
									<span>{FORCE_ACK_LABEL}</span>
								</label>
								<div className="mt-3 flex items-center gap-2">
									<button
										type="button"
										className="btn btn-danger btn-sm"
										disabled={pending || !forceAck}
										title={forceAck ? undefined : "请先勾选确认影响后强制断开"}
										onClick={forceDisconnect}
									>
										强制断开
									</button>
									<button type="button" className={PLAIN_ACTION} onClick={cancelDisconnect}>
										取消
									</button>
								</div>
							</div>
						) : (
							<div>
								<p className="text-[11px] text-ink-faint">
									清除已存凭据（API Key / OAuth）并恢复未接入态；环境变量提供的凭据不受影响。
								</p>
								<button
									type="button"
									className={DANGER_ACTION}
									disabled={writesBlocked}
									title={blockedTitle}
									onClick={beginDisconnect}
								>
									断开
								</button>
							</div>
						)}
					</Section>
				</div>
			)}
		</div>
	);
}

/** 展开态分区（细标题 + 内容；末段不带分隔线）。 */
function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
	return (
		<div className="border-b border-hairline py-4 last:border-b-0">
			<div className="mb-2 text-[11px] font-medium text-ink-faint">{title}</div>
			{children}
		</div>
	);
}
