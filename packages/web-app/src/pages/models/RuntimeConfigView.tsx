import type {
	ConfigInheritanceRestoreDto,
	ConfigScope,
	ConfigScopeDto,
	ModelCatalogDto,
	ModelSelectionDto,
} from "@cornfield/wire";
import { useCallback, useEffect, useState } from "react";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import { ModelSelectionSection } from "./config/ModelSelectionSection";
import { RoleEditorSection } from "./config/RoleEditorSection";
import {
	describeRoleSave,
	MODEL_ROUTES_KEY,
	type RoleEditorSavePayload,
	type RoleSaveResult,
} from "./config/role-editor";
import { ScopeKeysSection } from "./config/ScopeKeysSection";
import { describeModelWrite, describeRestore, describeWriteResult, toScopeInheritanceView } from "./config/scope-view";

/**
 * 运行时配置（模型控制中心 #05：配置作用域页）。
 * 作用域语义同 coding-agent Settings：global = <agentDir>/config.yml，project = <cwd>/.cornfield/config.yml，
 * 项目覆盖按 deepMerge 合并于全局之上。本页提供：
 * - 作用域切换器（全局 / 当前项目）：决定逐键编辑器的写入目标；读侧始终三层并陈（项目值/全局值/生效值）；
 * - 逐键三层展示 + 覆盖高亮 + 「恢复继承」（删除项目覆盖，不复制全局值）；
 * - 模型选择语义分离：仅当前会话（setModelTemporary，不落盘）与持久默认（setPersistentDefaultModel，写全局配置）；
 * - 写入后展示实际写入作用域（含文件路径）与刷新后的生效值；
 * - 角色配置编辑器（#07）：各角色主模型与回退链的草稿式编辑（本地草稿 + 保存前 diff + 校验闸门），
 *   确认后一次 setConfigValue 原子写入 modelRoutes，成功后重拉作用域与目录。
 * 错误态沿用 T01 banner 模式：fetch 失败可重试、动作失败可清除，均可见不静默。
 */
export function RuntimeConfigView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [scopeData, setScopeData] = useState<ConfigScopeDto | null>(null);
	const [selection, setSelection] = useState<ModelSelectionDto | null>(null);
	/** 全量模型目录（get_model_catalog）：选择器 + 角色编辑器校验共用；拉取失败降级为空（不阻断整页）。 */
	const [catalog, setCatalog] = useState<ModelCatalogDto | null>(null);
	/** 首次拉取失败（可见 + 重试）。 */
	const [fetchError, setFetchError] = useState<string | null>(null);
	/** 动作（恢复继承 / 写入 / 模型切换）失败（可见 + 清除）。 */
	const [actionError, setActionError] = useState<string | null>(null);
	/** 最近一次成功动作的结果说明（写入作用域 + 生效值 / 恢复继承结果）。 */
	const [notice, setNotice] = useState<string | null>(null);
	/** in-flight 动作标记（`restore:<key>` / `write:<key>` / `model`），期间禁用全部动作按钮。 */
	const [busy, setBusy] = useState<string | null>(null);
	/** 页面级写入作用域（作用域切换器；读侧不受影响，三层始终并陈）。 */
	const [writeTarget, setWriteTarget] = useState<ConfigScope>("global");

	/** 重新拉取作用域与模型选择（写入/恢复/切换后同步刷新；目录无需重拉）。 */
	const refreshScopeAndSelection = useCallback(async (): Promise<[ConfigScopeDto, ModelSelectionDto]> => {
		const [scope, sel] = await Promise.all([store.fetchConfigScope(), store.fetchModelSelection()]);
		setScopeData(scope);
		setSelection(sel);
		return [scope, sel];
	}, [store]);

	/** 全量拉取（作用域 + 模型选择 + 目录）；失败写 fetchError 供渲染可诊断信息。 */
	const loadAll = useCallback(() => {
		if (!view.connected) return;
		setFetchError(null);
		Promise.all([store.fetchConfigScope(), store.fetchModelSelection(), store.fetchModelCatalog()])
			.then(([scope, sel, cat]) => {
				setScopeData(scope);
				setSelection(sel);
				setCatalog(cat);
			})
			.catch((err: unknown) => setFetchError(errorText(err)));
	}, [store, view.connected]);

	useEffect(() => {
		loadAll();
	}, [loadAll]);

	/** 恢复继承：删除该键的项目覆盖（不复制全局值），完成后报删除结果与回落生效值。 */
	const restoreInheritance = async (key: string): Promise<void> => {
		if (busy) return;
		setBusy(`restore:${key}`);
		setActionError(null);
		setNotice(null);
		let dto: ConfigInheritanceRestoreDto;
		try {
			dto = await store.restoreConfigInheritance(key);
		} catch (err) {
			setActionError(`恢复继承失败：${errorText(err)}`);
			setBusy(null);
			return;
		}
		// 删除已提交；刷新失败不推翻删除事实，只报刷新问题
		try {
			await refreshScopeAndSelection();
		} catch (err) {
			setActionError(`覆盖已删除，但刷新作用域失败：${errorText(err)}`);
			setBusy(null);
			return;
		}
		setNotice(describeRestore(dto));
		setBusy(null);
	};

	/** 按作用域写入：完成后重拉作用域，用刷新后的合并视图报实际写入作用域与生效值。 */
	const writeConfig = async (key: string, value: unknown, scope: ConfigScope): Promise<void> => {
		if (busy) return;
		setBusy(`write:${key}`);
		setActionError(null);
		setNotice(null);
		try {
			await store.setConfigValue(key, value, scope);
		} catch (err) {
			setActionError(`写入配置失败：${errorText(err)}`);
			setBusy(null);
			return;
		}
		// 写入已提交；刷新失败不推翻写入事实，只报刷新问题
		try {
			const [fresh] = await refreshScopeAndSelection();
			const row = fresh.keys.find(k => k.key === key);
			setNotice(
				describeWriteResult({
					key,
					scope,
					scopePath: scope === "global" ? fresh.globalConfigPath : fresh.projectConfigPath,
					effectiveValue: row?.effectiveValue,
				}),
			);
		} catch (err) {
			setActionError(`写入已提交，但刷新作用域失败（生效值以重进页面为准）：${errorText(err)}`);
		}
		setBusy(null);
	};

	/**
	 * #07 角色编辑器保存：一次 setConfigValue 原子写入 modelRoutes（校验闸门在编辑器侧，失败不会走到这里）。
	 * 颜色元数据（modelTags）为附带写入：失败如实上报（角色配置本身已生效，颜色回落默认展示），不回滚路由写入。
	 * 成功后重拉作用域 + 模型选择 + 目录（所有模型选择入口读取同一最终配置）。
	 */
	const saveRoleEditor = async (payload: RoleEditorSavePayload): Promise<RoleSaveResult> => {
		if (busy) return { ok: false, error: "已有操作进行中，请稍后重试" };
		setBusy(`write:${MODEL_ROUTES_KEY}`);
		setNotice(null);
		try {
			await store.setConfigValue(MODEL_ROUTES_KEY, payload.routes, payload.scope);
		} catch (err) {
			setBusy(null);
			return { ok: false, error: `写入配置失败：${errorText(err)}` };
		}
		let tagsError: string | null = null;
		if (payload.tags) {
			try {
				await store.setConfigValue("modelTags", payload.tags, payload.scope);
			} catch (err) {
				tagsError = errorText(err);
			}
		}
		// 写入已提交；刷新失败不推翻写入事实，只报刷新问题
		let refreshError: string | null = null;
		let scopePath: string | undefined;
		try {
			const [fresh] = await refreshScopeAndSelection();
			scopePath = payload.scope === "global" ? fresh.globalConfigPath : fresh.projectConfigPath;
			setCatalog(await store.fetchModelCatalog());
		} catch (err) {
			refreshError = errorText(err);
		}
		const notice = describeRoleSave({
			scope: payload.scope,
			scopePath,
			changedCount: payload.changedCount,
			tagsWritten: payload.tags !== null,
			tagsError,
			refreshError,
		});
		setNotice(notice);
		setBusy(null);
		return { ok: true, notice };
	};

	/** 临时切换：仅当前会话（set_model_temporary 语义），不落盘。 */
	const temporaryModel = async (provider: string, modelId: string): Promise<void> => {
		if (busy) return;
		setBusy("model");
		setActionError(null);
		setNotice(null);
		try {
			await store.setModelTemporary(provider, modelId);
		} catch (err) {
			setActionError(`临时切换失败：${errorText(err)}`);
			setBusy(null);
			return;
		}
		try {
			await refreshScopeAndSelection();
		} catch (err) {
			setActionError(`切换已生效，但刷新视图失败：${errorText(err)}`);
			setBusy(null);
			return;
		}
		setNotice(describeModelWrite("temporary", provider, modelId));
		setBusy(null);
	};

	/** 设为持久默认（写全局配置 modelRoutes.default.primary），与临时切换是两条链路。 */
	const persistModel = async (provider: string, modelId: string): Promise<void> => {
		if (busy) return;
		setBusy("model");
		setActionError(null);
		setNotice(null);
		try {
			await store.setPersistentDefaultModel(provider, modelId);
		} catch (err) {
			setActionError(`设置持久默认失败：${errorText(err)}`);
			setBusy(null);
			return;
		}
		try {
			await refreshScopeAndSelection();
		} catch (err) {
			setActionError(`持久默认已写入，但刷新视图失败：${errorText(err)}`);
			setBusy(null);
			return;
		}
		setNotice(describeModelWrite("persist", provider, modelId));
		setBusy(null);
	};

	/** 快捷隐藏 provider（同 Provider 工作区停用链路：写全局停用名单 disabledProviders）。 */
	const hideProvider = async (provider: string): Promise<void> => {
		if (busy) return;
		setBusy(`hide:${provider}`);
		setActionError(null);
		setNotice(null);
		try {
			await store.setModelDisabled(provider, undefined, true);
		} catch (err) {
			setActionError(`隐藏 provider 失败：${errorText(err)}`);
			setBusy(null);
			return;
		}
		// 停用已提交；刷新失败不推翻停用事实，只报刷新问题（重进页面目录/选择器都会同步）
		try {
			setCatalog(await store.fetchModelCatalog());
			await refreshScopeAndSelection();
		} catch (err) {
			setActionError(`已隐藏 ${provider}，但刷新目录失败：${errorText(err)}`);
			setBusy(null);
			return;
		}
		setNotice(`已隐藏 provider「${provider}」：其模型已从选择器移除（写全局停用名单，可在 Provider 工作区恢复）`);
		setBusy(null);
	};

	const inheritance = scopeData ? toScopeInheritanceView(scopeData) : null;
	/** 写入目标路径提示：项目不存在时明确「首次写入时新建」。 */
	const writeTargetPath =
		writeTarget === "global"
			? (inheritance?.globalConfigPath ?? "<agentDir>/config.yml")
			: (inheritance?.projectConfigPath ?? "尚未创建 .cornfield/config.yml（首次写入时新建）");

	return (
		<div>
			<div className="mb-5 flex items-baseline justify-between gap-4">
				<h2 className="section-title text-[15px]">运行时配置</h2>
				<span className="text-[12px] text-ink-faint">
					{inheritance
						? `${inheritance.overriddenKeys.length} 个键被项目覆盖 · ${inheritance.inheritingGlobal ? "项目级配置缺失" : "项目级配置生效中"}`
						: "读取配置作用域中…"}
				</span>
			</div>

			{/* 项目级配置缺失：明确显示正在继承全局（ticket 05 要求文案） */}
			{inheritance?.inheritingGlobal && (
				<div className="mb-5 flex items-center gap-3 rounded-lg border border-hairline bg-surface-2 px-4 py-2.5 text-[12px] text-ink-subtle">
					<span className="flex-1">{inheritance.inheritanceBanner}</span>
				</div>
			)}

			{/* 拉取失败（可见 + 重试，T01 banner 模式） */}
			{fetchError && (
				<div className="mb-5 flex items-center gap-3 rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
					<span className="flex-1">配置作用域不可用：{fetchError}</span>
					<button
						type="button"
						className="shrink-0 rounded border border-danger/30 px-2 py-0.5 transition-colors hover:bg-danger/10"
						onClick={loadAll}
					>
						重试
					</button>
				</div>
			)}

			{/* 动作失败（可见 + 清除，T01 banner 模式） */}
			{actionError && (
				<div className="mb-5 flex items-center gap-3 rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
					<span className="flex-1">{actionError}</span>
					<button
						type="button"
						className="shrink-0 rounded border border-danger/30 px-2 py-0.5 transition-colors hover:bg-danger/10"
						onClick={() => setActionError(null)}
					>
						清除
					</button>
				</div>
			)}

			{/* 成功动作结果：实际写入作用域 / 恢复继承结果 / 模型写入语义（可清除） */}
			{notice && (
				<div className="mb-5 flex items-center gap-3 rounded-lg border border-accent/40 bg-accent-dim/40 px-4 py-2.5 text-[12px] text-ink">
					<span className="flex-1">{notice}</span>
					<button
						type="button"
						className="shrink-0 rounded border border-accent/30 px-2 py-0.5 transition-colors hover:bg-accent-dim"
						onClick={() => setNotice(null)}
					>
						清除
					</button>
				</div>
			)}

			{/* 作用域切换器：决定逐键编辑器的写入目标（读侧三层始终并陈） */}
			<div className="mb-3 flex flex-wrap items-center gap-4 rounded-xl border border-hairline bg-surface px-5 py-3.5">
				<div className="flex w-fit gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
					{(
						[
							{ id: "global", label: "全局" },
							{ id: "project", label: "当前项目" },
						] as const
					).map(opt => (
						<button
							key={opt.id}
							type="button"
							className={`rounded px-3 py-1 text-[12px] transition-colors ${writeTarget === opt.id ? "bg-accent-dim font-medium text-ink" : "text-ink-subtle hover:text-ink"}`}
							onClick={() => setWriteTarget(opt.id)}
						>
							{opt.label}
						</button>
					))}
				</div>
				<div className="min-w-0 flex-1 text-[11.5px] text-ink-faint">
					写入目标：<span className="font-mono text-ink-subtle">{writeTargetPath}</span>
					{inheritance && (
						<span className="ml-3">
							全局配置 <span className="font-mono">{inheritance.globalConfigPath}</span>
							{inheritance.projectConfigPath && (
								<>
									{" · "}项目配置 <span className="font-mono">{inheritance.projectConfigPath}</span>
								</>
							)}
						</span>
					)}
				</div>
			</div>

			{!scopeData || !selection ? (
				fetchError ? null : (
					<>
						<div className="skeleton h-10 w-full" />
						<div className="skeleton h-10 w-full" />
						<div className="skeleton h-10 w-full" />
					</>
				)
			) : (
				<div className="space-y-7">
					<section>
						<div className="mb-2.5 flex items-baseline gap-3">
							<span className="section-title text-[13px]">逐键配置</span>
							<span className="text-[11px] text-ink-faint">
								项目值覆盖全局值（deepMerge）；「恢复继承」删除项目覆盖，不复制全局值
							</span>
						</div>
						<ScopeKeysSection
							scope={scopeData}
							writeTarget={writeTarget}
							busy={busy}
							onRestore={key => void restoreInheritance(key)}
							onWrite={(key, value, scope) => void writeConfig(key, value, scope)}
						/>
					</section>

					<section>
						<div className="mb-2.5 flex items-baseline gap-3">
							<span className="section-title text-[13px]">模型选择</span>
							<span className="text-[11px] text-ink-faint">
								仅当前会话（临时，不落盘）与持久默认（写全局配置）语义分离
							</span>
						</div>
						<ModelSelectionSection
							selection={selection}
							catalog={catalog}
							busy={busy !== null}
							onTemporary={(provider, modelId) => void temporaryModel(provider, modelId)}
							onPersist={(provider, modelId) => void persistModel(provider, modelId)}
							onHideProvider={hideProvider}
						/>
					</section>

					<section>
						<div className="mb-2.5 flex items-baseline gap-3">
							<span className="section-title text-[13px]">角色配置</span>
							<span className="text-[11px] text-ink-faint">
								各角色的主模型与回退链（modelRoutes）；草稿 + 保存前 diff + 校验闸门，确认后一次 setConfigValue
								原子写入
							</span>
						</div>
						<RoleEditorSection
							scope={scopeData}
							writeTarget={writeTarget}
							catalog={catalog}
							busy={busy}
							onSave={saveRoleEditor}
							onRestoreInheritance={() => void restoreInheritance(MODEL_ROUTES_KEY)}
						/>
					</section>
				</div>
			)}
		</div>
	);
}

function errorText(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
