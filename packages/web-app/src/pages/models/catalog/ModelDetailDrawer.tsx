import type { ConfigScopeDto, ModelCatalogEntryDto, ModelTestResultDto, ProviderCatalogMetaDto } from "@cornfield/wire";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { errorText } from "../providers/provider-display";
import { formatContextTokens, formatIsoTime, formatPriceUsd, keyOf, SOURCE_LABELS, STATUS_META } from "./catalog-logic";
import { StatusBadge } from "./StatusBadge";
import { canRunConnectivityTest, formatLatency, TEST_OUTCOME_META, testConfirmNotice } from "./test-outcome";

/**
 * 模型详情抽屉（#02/#04）——完整能力/限制、价格、数据来源（ProviderCatalogMetaDto）、更新时间、
 * 接入情况与引用角色；含会话临时切换（文案不伪装成持久默认）与「连通性测试」#04 实装：
 * 点击 → 确认（说明会产生一次真实调用与费用）→ 执行 → 展示 outcome/耗时/消息。
 * 纯展示：数据由 CatalogView 传入，操作经回调上抛。
 */
export function ModelDetailDrawer({
	entry,
	providerMeta,
	generatedAt,
	configScope,
	scopeUnavailable,
	isCurrent,
	tempBusy,
	onTemporarySwitch,
	onConnectivityTest,
	onClose,
}: {
	entry: ModelCatalogEntryDto;
	/** 该模型所属 provider 的目录元数据（可能缺省）。 */
	providerMeta?: ProviderCatalogMetaDto;
	/** 目录生成时间（ModelCatalogDto.generatedAt）。 */
	generatedAt?: string;
	/** 配置作用域（get_config_scope）——临时切换与持久默认的边界说明。 */
	configScope: ConfigScopeDto | null;
	/** 作用域读取失败（可见提示，不阻断抽屉）。 */
	scopeUnavailable: boolean;
	isCurrent: boolean;
	tempBusy: boolean;
	onTemporarySwitch: () => void;
	/** 连通性测试（test_model；确认后执行，返回六类 outcome 结果；命令失败时 reject）。 */
	onConnectivityTest: () => Promise<ModelTestResultDto>;
	onClose: () => void;
}): React.JSX.Element {
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const meta = STATUS_META[entry.status];
	const detailTone =
		entry.status === "credential-invalid" || entry.status === "local-offline" ? "text-danger" : "text-ink-subtle";

	// ── 连通性测试（#04）：未确认不执行；结果/错误均为可见态 ──
	const [testConfirmOpen, setTestConfirmOpen] = useState(false);
	const [testBusy, setTestBusy] = useState(false);
	const [testResult, setTestResult] = useState<ModelTestResultDto | null>(null);
	const [testError, setTestError] = useState<string | null>(null);
	const canTest = canRunConnectivityTest(entry);

	const runConnectivityTest = (): void => {
		setTestBusy(true);
		setTestError(null);
		void onConnectivityTest()
			.then(result => {
				setTestResult(result);
				setTestConfirmOpen(false);
			})
			.catch((err: unknown) => setTestError(`连通性测试失败：${errorText(err)}`))
			.finally(() => setTestBusy(false));
	};

	return (
		<div
			className="fixed inset-0 z-modal flex justify-end bg-ink/40"
			role="dialog"
			aria-modal="true"
			aria-label={`${entry.name} 详情`}
		>
			<aside className="flex h-full w-[460px] flex-col overflow-hidden border-l border-hairline bg-surface shadow-2xl">
				<div className="flex shrink-0 items-start justify-between gap-3 border-b border-hairline px-6 py-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<span className="truncate text-[16px] font-semibold text-ink">{entry.name}</span>
							<StatusBadge status={entry.status} />
						</div>
						<div className="mt-0.5 truncate font-mono text-[12px] text-ink-faint">{keyOf(entry)}</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="关闭详情"
						className="shrink-0 rounded px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
					>
						关闭 ✕
					</button>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto">
					<Section title="接入情况">
						<p className="text-[12px] leading-relaxed text-ink-subtle">{meta.hint}</p>
						{entry.statusDetail && (
							<p className={`mt-1.5 text-[12px] leading-relaxed ${detailTone}`}>{entry.statusDetail}</p>
						)}
						{entry.status === "provider-not-configured" && (
							<p className="mt-2 text-[12px]">
								{"该 Provider 尚未接入——"}
								<Link
									to={`/models/providers?provider=${encodeURIComponent(entry.provider)}`}
									className="text-accent underline decoration-hairline underline-offset-2 hover:decoration-accent"
								>
									去 Provider 工作区接入
								</Link>
							</p>
						)}
						<Kv label="引用角色">
							{entry.roles.length > 0 ? (
								<span className="flex flex-wrap gap-1">
									{entry.roles.map(r => (
										<span
											key={r}
											className="rounded bg-surface-2 px-1.5 py-px font-mono text-3xs text-ink-muted"
										>
											{r}
										</span>
									))}
								</span>
							) : (
								<span className="text-ink-faint">未被任何角色引用</span>
							)}
						</Kv>
					</Section>

					<Section title="当前会话使用">
						{entry.status === "available" ? (
							<>
								<button
									type="button"
									className="btn btn-sm"
									disabled={tempBusy || isCurrent}
									onClick={onTemporarySwitch}
								>
									{isCurrent ? "当前使用中" : tempBusy ? "切换中…" : "临时切换到该模型"}
								</button>
								<p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
									仅当前会话生效，不写入持久默认配置。
									{configScope
										? ` 持久默认在运行时配置中维护（${configScope.globalConfigPath}${
												configScope.hasProjectConfig
													? `；项目覆盖${configScope.projectConfigPath ? `：${configScope.projectConfigPath}` : "已启用"}`
													: "；无项目覆盖"
											}）。`
										: scopeUnavailable
											? " 配置作用域信息不可用。"
											: ""}
								</p>
							</>
						) : (
							<p className="text-[12px] text-ink-subtle">
								仅「可用」状态的模型可临时切换（当前：{meta.label}）。
							</p>
						)}
					</Section>

					<Section title="能力与限制">
						<Kv label="思考推理">{entry.capabilities.thinking ? "支持" : "不支持"}</Kv>
						<Kv label="视觉输入">{entry.capabilities.vision ? "支持" : "不支持"}</Kv>
						<Kv label="工具调用">{entry.capabilities.tools ? "支持" : "不支持"}</Kv>
						<Kv label="输入模态">{entry.capabilities.inputModalities.join(" / ") || "—"}</Kv>
						{entry.category && <Kv label="分类">{entry.category}</Kv>}
						<Kv label="上下文窗口">
							<span className="font-mono">{formatContextTokens(entry.contextWindowTokens)}</span>
							<span className="ml-1.5 text-3xs text-ink-faint">
								{entry.contextWindowTokens > 0
									? `${entry.contextWindowTokens.toLocaleString("en-US")} tokens`
									: "目录未提供"}
							</span>
						</Kv>
						{entry.description && (
							<p className="mt-2 text-[12px] leading-relaxed text-ink-subtle">{entry.description}</p>
						)}
					</Section>

					<Section title="价格（$ / 1M tokens）">
						<div className="grid grid-cols-2 gap-2">
							<PriceCell label="输入" value={entry.pricing.input} />
							<PriceCell label="输出" value={entry.pricing.output} />
							<PriceCell label="缓存读" value={entry.pricing.cacheRead} />
							<PriceCell label="缓存写" value={entry.pricing.cacheWrite} />
						</div>
					</Section>

					<Section title="数据来源与更新">
						{providerMeta ? (
							<>
								<Kv label="来源">
									{SOURCE_LABELS[providerMeta.source]}
									<span className="ml-1.5 font-mono text-3xs text-ink-faint">{providerMeta.source}</span>
								</Kv>
								<Kv label="发现模型">{providerMeta.discoveredCount} 个（未按停用过滤）</Kv>
								<Kv label="上次刷新">{formatIsoTime(providerMeta.lastRefreshAt)}</Kv>
								<Kv label="目录生成">{formatIsoTime(generatedAt)}</Kv>
								{providerMeta.stale && (
									<div className="mt-1.5">
										<span className="badge info">非权威数据（可能过期）</span>
									</div>
								)}
								{providerMeta.refreshError && (
									<div className="mt-2 rounded bg-danger/5 px-2 py-1.5 text-[12px] leading-relaxed text-danger">
										上次刷新失败：{providerMeta.refreshError}
									</div>
								)}
							</>
						) : (
							<p className="text-[12px] text-ink-faint">该 Provider 暂无目录元数据。</p>
						)}
					</Section>

					<Section title="连通性测试">
						{testResult ? (
							<div>
								<div className="flex flex-wrap items-center gap-2">
									<span className={`badge ${TEST_OUTCOME_META[testResult.outcome].badge}`}>
										{TEST_OUTCOME_META[testResult.outcome].label}
									</span>
									<span
										className="font-mono text-[11px] text-ink-faint"
										title="端到端耗时（含 Provider 内部重试）"
									>
										{formatLatency(testResult.latencyMs)}
									</span>
									{testResult.httpStatus !== undefined && (
										<span className="font-mono text-[11px] text-ink-faint">HTTP {testResult.httpStatus}</span>
									)}
								</div>
								<p
									className={`mt-1.5 break-words text-[12px] leading-relaxed ${
										testResult.outcome === "success" ? "text-success" : "text-danger"
									}`}
								>
									{testResult.message}
								</p>
								<p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
									{TEST_OUTCOME_META[testResult.outcome].hint}
								</p>
								<button
									type="button"
									className="btn btn-sm mt-2"
									disabled={testBusy}
									onClick={() => setTestConfirmOpen(true)}
								>
									再次测试
								</button>
							</div>
						) : testConfirmOpen ? (
							<div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
								<p className="text-[12px] leading-relaxed text-warning">{testConfirmNotice(keyOf(entry))}</p>
								<div className="mt-2 flex items-center gap-2">
									<button
										type="button"
										className="btn btn-sm"
										disabled={testBusy}
										onClick={runConnectivityTest}
									>
										{testBusy ? "测试中…" : "确认执行"}
									</button>
									<button
										type="button"
										disabled={testBusy}
										className="rounded px-2 py-1 text-[11.5px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
										onClick={() => setTestConfirmOpen(false)}
									>
										取消
									</button>
								</div>
							</div>
						) : (
							<div>
								<button
									type="button"
									className="btn btn-sm"
									disabled={testBusy || !canTest}
									title={canTest ? "先确认再执行（真实调用）" : "该 Provider 未接入，无可测凭据"}
									onClick={() => setTestConfirmOpen(true)}
								>
									发起连通性测试
								</button>
								{!canTest && (
									<p className="mt-1.5 text-[11.5px] text-ink-faint">该 Provider 未接入，无可测凭据。</p>
								)}
								<p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
									对单个模型发起一次最小真实调用，验证凭据、权限与响应并展示耗时。
								</p>
							</div>
						)}
						{testError && (
							<div className="mt-2 rounded bg-danger/5 px-2 py-1.5 text-[12px] leading-relaxed text-danger">
								{testError}
							</div>
						)}
					</Section>
				</div>
			</aside>
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
	return (
		<section className="border-b border-hairline px-6 py-4 last:border-b-0">
			<h3 className="section-title mb-2.5">{title}</h3>
			{children}
		</section>
	);
}

function Kv({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
	return (
		<div className="flex items-baseline gap-3 py-1 text-[12.5px]">
			<span className="w-[92px] shrink-0 text-ink-faint">{label}</span>
			<span className="min-w-0 flex-1 text-ink">{children}</span>
		</div>
	);
}

function PriceCell({ label, value }: { label: string; value: number }): React.JSX.Element {
	return (
		<div className="rounded-lg bg-surface-2 px-3 py-2">
			<div className="font-mono text-[14px] font-semibold text-ink">{formatPriceUsd(value)}</div>
			<div className="text-[11px] text-ink-faint">{label}</div>
		</div>
	);
}
