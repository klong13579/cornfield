import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getSupportedEfforts, type Model, modelsAreEqual } from "@oh-my-pi/pi-ai";
import {
	Container,
	getKeybindings,
	Input,
	matchesKey,
	Spacer,
	type Tab,
	TabBar,
	Text,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import { getKnownRoleIds, getRoleInfo, MODEL_ROLE_IDS, MODEL_ROLES } from "../../config/model-registry";
import { resolveModelRoleValue } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import { type ThemeColor, theme } from "../../modes/theme/theme";
import { getThinkingLevelMetadata } from "../../thinking";
import { fuzzyFilter } from "../../utils/fuzzy";
import { getTabBarTheme } from "../shared";
import { DynamicBorder } from "./dynamic-border";

function makeInvertedBadge(label: string, color: ThemeColor): string {
	const fgAnsi = theme.getFgAnsi(color);
	const bgAnsi = fgAnsi.replace(/\x1b\[38;/g, "\x1b[48;");
	return `${bgAnsi}\x1b[30m ${label} \x1b[39m\x1b[49m`;
}

const MODEL_FAILURES_FILE = path.join(homedir(), ".omp/agent/model-failures.json");

function formatModelNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}

function loadModelFailures(): Record<string, number> {
	try {
		const content = fs.readFileSync(MODEL_FAILURES_FILE, "utf8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function formatModelInfoString(model: Model, failures: Record<string, number>): string {
	const costStr = model.cost ? `$${model.cost.input}/${model.cost.output}` : "$0/0";
	const ctx = model.contextWindow ? formatModelNumber(model.contextWindow) : "-";
	const think = model.reasoning ? "reasoning" : "-";
	const inputTypes = model.input?.join("+") ?? "text";
	const modelKey = `${model.provider}/${model.id}`;
	const failCount = failures[modelKey] ?? 0;
	const failStr = failCount > 0 ? `\xa0err*${failCount}` : "";
	return `[${costStr} · ${ctx} ctx · ${think} · ${inputTypes}${failStr}]`;
}

function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function compactSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getAlphaSearchTokens(query: string): string[] {
	return [...normalizeSearchText(query).matchAll(/[a-z]+/g)].map(match => match[0]).filter(token => token.length > 0);
}

function computeModelRank(model: Model, roles: Record<string, RoleAssignment | undefined>): number {
	let i = 0;
	while (i < MODEL_ROLE_IDS.length) {
		const role = MODEL_ROLE_IDS[i];
		const assigned = roles[role];
		if (assigned && modelsAreEqual(assigned.model, model)) {
			break;
		}
		i++;
	}
	return i;
}

interface ModelItem {
	kind: "provider";
	provider: string;
	id: string;
	model: Model;
	selector: string;
}

interface CanonicalModelItem {
	kind: "canonical";
	id: string;
	model: Model;
	selector: string;
	variantCount: number;
	searchText: string;
	normalizedSearchText: string;
	compactSearchText: string;
}

interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

interface RoleAssignment {
	model: Model;
	thinkingLevel: ThinkingLevel;
}

type RoleSelectCallback = (model: Model, role: string | null, thinkingLevel?: ThinkingLevel, selector?: string) => void;
type CancelCallback = () => void;
interface MenuRoleAction {
	label: string;
	role: string; // now accepts custom role strings
}

const ALL_TAB = "ALL";
const CANONICAL_TAB = "CANONICAL";

/** Providers hidden from the interactive model selector. */
const BLOCKED_PROVIDERS = new Set(["ollama", "llama.cpp", "lm-studio"]);

// ---------------------------------------------------------------------------
// Group definitions (UX spec: 5 functional groups + All)
// ---------------------------------------------------------------------------

type GroupCategory = "chat" | "coding" | "reasoning" | "vision" | "asr" | "tts" | "image" | "video" | "embedding";

interface Group {
	/** Stable id used for the group tab label. */
	id: string;
	/** Display label. */
	label: string;
	/** Categories that belong to this group. Empty array = "All" (no filter). */
	categories: GroupCategory[];
}

const ALL_GROUP: Group = { id: "all", label: "All", categories: [] };

const FUNCTIONAL_GROUPS: Group[] = [
	{ id: "main", label: "\u4e3b\u529b", categories: ["chat", "coding"] },
	{ id: "reasoning", label: "Reasoning", categories: ["reasoning"] },
	{ id: "vision", label: "Vision", categories: ["vision"] },
	{ id: "tts", label: "TTS", categories: ["tts"] },
	{ id: "asr", label: "ASR", categories: ["asr"] },
	{ id: "embedding", label: "Embedding", categories: ["embedding"] },
	{ id: "more", label: "More", categories: ["image", "video"] },
];

/** Emoji prefix per category. Falls back to empty string when category is unknown. */
const CATEGORY_EMOJI: Record<GroupCategory, string> = {
	chat: "💬",
	coding: "💻",
	reasoning: "🧠",
	vision: "👁",
	asr: "🎤",
	tts: "🔊",
	image: "🎨",
	video: "🎬",
	embedding: "🔢",
};

function emojiForCategory(model: Model): string {
	const cat = model.category as GroupCategory | undefined;
	return cat ? CATEGORY_EMOJI[cat] : "";
}

/** 3-layer state machine. ALL/CANONICAL skip the group layer. */
type SelectorLayer = "provider" | "group" | "list";

/**
 * Component that renders a model selector with provider tabs and context menu.
 * - Tab/Arrow Left/Right: Switch between provider tabs
 * - Arrow Up/Down: Navigate model list
 * - Enter: Open context menu to select action
 * - Escape: Close menu or selector
 */
export class ModelSelectorComponent extends Container {
	#searchInput: Input;
	#headerContainer: Container;
	#tabBar: TabBar | null = null;
	#groupTabBar: TabBar | null = null;
	#listContainer: Container;
	#menuContainer: Container;
	#allModels: ModelItem[] = [];
	#filteredModels: ModelItem[] = [];
	#canonicalModels: CanonicalModelItem[] = [];
	#filteredCanonicalModels: CanonicalModelItem[] = [];
	/** Visible list combining pinned section + group-filtered items. */
	#visibleItems: (ModelItem | CanonicalModelItem)[] = [];
	#selectedIndex: number = 0;
	#roles = {} as Record<string, RoleAssignment | undefined>;
	#settings = null as unknown as Settings;
	#modelRegistry = null as unknown as ModelRegistry;
	#onSelectCallback = (() => {}) as RoleSelectCallback;
	#onCancelCallback = (() => {}) as CancelCallback;
	#errorMessage?: unknown;
	#tui: TUI;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#temporaryOnly: boolean;

	#menuRoleActions: MenuRoleAction[] = [];

	// Tab state
	#providers: string[] = [ALL_TAB];
	#activeTabIndex: number = 0;
	/** Groups derived for the current provider (empty on ALL/CANONICAL). */
	#groups: Group[] = [];
	#activeGroupIndex: number = 0;
	/** Current focus layer in the 3-layer state machine. */
	#layer: SelectorLayer = "provider";
	/** Items currently in the pinned section (cross-group, scoped to current provider). */
	#pinnedItems: ModelItem[] = [];

	// Context menu state
	#isMenuOpen: boolean = false;
	#menuSelectedIndex: number = 0;
	#menuStep: "role" | "thinking" = "role";
	#menuSelectedRole: string | null = null;

	constructor(
		tui: TUI,
		_currentModel: Model | undefined,
		settings: Settings,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model, role: string | null, thinkingLevel?: ThinkingLevel, selector?: string) => void,
		onCancel: () => void,
		options?: { temporaryOnly?: boolean; initialSearchInput?: string },
	) {
		super();

		this.#tui = tui;
		this.#settings = settings;
		this.#modelRegistry = modelRegistry;
		this.#scopedModels = scopedModels;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#temporaryOnly = options?.temporaryOnly ?? false;
		const initialSearchInput = options?.initialSearchInput;

		// Initialize menu role actions (built-in + custom from settings)
		this.#buildMenuRoleActions();

		// Load current role assignments from settings
		this.#loadRoleModels();

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		const hintText =
			scopedModels.length > 0
				? "Showing models from --models scope"
				: "Only showing models with configured API keys (see README for details)";
		this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		this.addChild(new Spacer(1));

		// Create header container for tab bar
		this.#headerContainer = new Container();
		this.addChild(this.#headerContainer);

		this.addChild(new Spacer(1));

		// Create search input
		this.#searchInput = new Input();
		if (initialSearchInput) {
			this.#searchInput.setValue(initialSearchInput);
		}
		this.#searchInput.onSubmit = () => {
			// Enter on search input opens menu if we have a selection
			if (this.#filteredModels[this.#selectedIndex]) {
				this.#openMenu();
			}
		};
		this.addChild(this.#searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);

		// Create menu container (hidden by default)
		this.#menuContainer = new Container();
		this.addChild(this.#menuContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.#loadModels().then(() => {
			this.#buildProviderTabs();
			this.#updateTabBar();
			// Always apply the current search query — the user may have typed
			// while models were loading asynchronously.
			const currentQuery = this.#searchInput.getValue();
			if (currentQuery) {
				this.#filterModels(currentQuery);
			} else {
				this.#updateList();
			}
			// Request re-render after models are loaded
			this.#tui.requestRender();
		});
	}

	#buildMenuRoleActions(): void {
		this.#menuRoleActions = getKnownRoleIds(this.#settings).map(role => {
			const roleInfo = getRoleInfo(role, this.#settings);
			const roleLabel = roleInfo.tag ? `${roleInfo.tag} (${roleInfo.name})` : roleInfo.name;
			return {
				label: `Set as ${roleLabel}`,
				role,
			};
		});
	}

	/**
	 * Returns the canonical model key for the currently selected list item,
	 * or undefined if the selection is not a pinnable model (e.g. canonical tab).
	 */
	#getSelectedModelKey(): string | undefined {
		if (this.#isCanonicalTab()) return undefined;
		const item = this.#visibleItems[this.#selectedIndex] as ModelItem | undefined;
		if (!item || item.kind !== "provider") return undefined;
		return `${item.provider}/${item.id}`;
	}

	/**
	 * Returns the Pin/Unpin menu label for the current selection, or null when
	 * the selection is not pinnable.
	 */
	#getPinMenuLabel(): string | null {
		const key = this.#getSelectedModelKey();
		if (!key) return null;
		return this.#settings.isPinned(key) ? "Unpin from top" : "Pin to top";
	}

	#loadRoleModels(): void {
		const allModels = this.#modelRegistry.getAll();
		const matchPreferences = { usageOrder: this.#settings.getStorage()?.getModelUsageOrder() };
		for (const role of getKnownRoleIds(this.#settings)) {
			const roleValue = this.#settings.getModelRole(role);
			if (!roleValue) continue;

			const resolved = resolveModelRoleValue(roleValue, allModels, {
				settings: this.#settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
			});
			if (resolved.model) {
				this.#roles[role] = {
					model: resolved.model,
					thinkingLevel:
						resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined
							? resolved.thinkingLevel
							: ThinkingLevel.Inherit,
				};
			}
		}
	}

	#sortModels(models: ModelItem[]): void {
		// Sort: tagged models (default/smol/slow/plan) first, then MRU, then alphabetical
		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

		const modelRank = (item: ModelItem) => computeModelRank(item.model, this.#roles);

		const dateRe = /-(\d{8})$/;
		const latestRe = /-latest$/;

		models.sort((a, b) => {
			const aKey = a.selector;
			const bKey = b.selector;

			const aRank = modelRank(a);
			const bRank = modelRank(b);
			if (aRank !== bRank) return aRank - bRank;

			// Then MRU order (models in mruIndex come before those not in it)
			const aMru = mruIndex.get(aKey) ?? Number.MAX_SAFE_INTEGER;
			const bMru = mruIndex.get(bKey) ?? Number.MAX_SAFE_INTEGER;
			if (aMru !== bMru) return aMru - bMru;

			// By provider, then recency within provider
			const providerCmp = a.provider.localeCompare(b.provider);
			if (providerCmp !== 0) return providerCmp;

			// Priority field (lower = better, e.g. Codex priority values)
			const aPri = a.model.priority ?? Number.MAX_SAFE_INTEGER;
			const bPri = b.model.priority ?? Number.MAX_SAFE_INTEGER;
			if (aPri !== bPri) return aPri - bPri;

			// Version number descending (higher version = better model)
			const aVer = extractVersionNumber(a.id);
			const bVer = extractVersionNumber(b.id);
			if (aVer !== bVer) return bVer - aVer;

			const aIsLatest = latestRe.test(a.id);
			const bIsLatest = latestRe.test(b.id);
			const aDate = a.id.match(dateRe)?.[1] ?? "";
			const bDate = b.id.match(dateRe)?.[1] ?? "";

			// Both have dates or latest tags — sort by recency
			const aHasRecency = aIsLatest || aDate !== "";
			const bHasRecency = bIsLatest || bDate !== "";

			// Models with recency info come before those without
			if (aHasRecency !== bHasRecency) return aHasRecency ? -1 : 1;

			// If neither has recency info, fall back to alphabetical
			if (!aHasRecency) return a.id.localeCompare(b.id);

			// -latest always sorts first within recency group
			if (aIsLatest !== bIsLatest) return aIsLatest ? -1 : 1;

			// Both have dates — descending (newest first)
			if (aDate && bDate) return bDate.localeCompare(aDate);

			// One has date, other is latest — latest first
			return aIsLatest ? -1 : bIsLatest ? 1 : a.id.localeCompare(b.id);
		});
	}

	#sortCanonicalModels(models: CanonicalModelItem[]): void {
		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

		const modelRank = (item: CanonicalModelItem) => computeModelRank(item.model, this.#roles);

		models.sort((a, b) => {
			const aRank = modelRank(a);
			const bRank = modelRank(b);
			if (aRank !== bRank) return aRank - bRank;

			const aMru = mruIndex.get(`${a.model.provider}/${a.model.id}`) ?? Number.MAX_SAFE_INTEGER;
			const bMru = mruIndex.get(`${b.model.provider}/${b.model.id}`) ?? Number.MAX_SAFE_INTEGER;
			if (aMru !== bMru) return aMru - bMru;

			const providerCmp = a.model.provider.localeCompare(b.model.provider);
			if (providerCmp !== 0) return providerCmp;

			return a.id.localeCompare(b.id);
		});
	}

	async #loadModels(): Promise<void> {
		let models: ModelItem[];

		// Use scoped models if provided via --models flag
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => ({
				kind: "provider",
				provider: scoped.model.provider,
				id: scoped.model.id,
				model: scoped.model,
				selector: `${scoped.model.provider}/${scoped.model.id}`,
			}));
		} else {
			// Reload config and cached discovery state without blocking on live provider refresh
			await this.#modelRegistry.refresh("offline");

			// Check for models.json errors
			const loadError = this.#modelRegistry.getError();
			if (loadError) {
				this.#errorMessage = loadError;
			} else {
				this.#errorMessage = undefined;
			}

			// Load available models (built-in models still work even if models.json failed)
			try {
				const availableModels = this.#modelRegistry.getAvailable().filter(m => !BLOCKED_PROVIDERS.has(m.provider));
				models = availableModels.map((model: Model) => ({
					kind: "provider",
					provider: model.provider,
					id: model.id,
					model,
					selector: `${model.provider}/${model.id}`,
				}));
			} catch (error) {
				this.#allModels = [];
				this.#filteredModels = [];
				this.#canonicalModels = [];
				this.#filteredCanonicalModels = [];
				this.#errorMessage = error instanceof Error ? error.message : String(error);
				return;
			}
		}

		const canonicalRecords = this.#modelRegistry.getCanonicalModels({
			availableOnly: this.#scopedModels.length === 0,
			candidates: models.map(item => item.model),
		});
		const canonicalModels = canonicalRecords
			.map(record => {
				const selectedModel = this.#modelRegistry.resolveCanonicalModel(record.id, {
					availableOnly: this.#scopedModels.length === 0,
					candidates: models.map(item => item.model),
				});
				if (!selectedModel) return undefined;
				const searchText = [
					record.id,
					record.name,
					selectedModel.provider,
					selectedModel.id,
					selectedModel.name,
					...record.variants.flatMap(variant => [variant.selector, variant.model.name]),
				].join(" ");
				return {
					kind: "canonical" as const,
					id: record.id,
					model: selectedModel,
					selector: record.id,
					variantCount: record.variants.length,
					searchText,
					normalizedSearchText: normalizeSearchText(searchText),
					compactSearchText: compactSearchText(searchText),
				};
			})
			.filter((item): item is CanonicalModelItem => item !== undefined);

		this.#sortModels(models);
		this.#sortCanonicalModels(canonicalModels);

		this.#allModels = models;
		this.#filteredModels = models;
		this.#canonicalModels = canonicalModels;
		this.#filteredCanonicalModels = canonicalModels;
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, models.length - 1));
		this.#refreshGroupsAndList();
	}

	#buildProviderTabs(): void {
		const providerSet = new Set<string>();
		for (const item of this.#allModels) {
			providerSet.add(item.provider.toUpperCase());
		}
		for (const provider of this.#modelRegistry.getDiscoverableProviders()) {
			if (BLOCKED_PROVIDERS.has(provider)) continue;
			providerSet.add(provider.toUpperCase());
		}
		const sortedProviders = Array.from(providerSet).sort();
		this.#providers = [ALL_TAB, CANONICAL_TAB, ...sortedProviders];
	}

	/**
	 * Compute the group tabs available for the current provider.
	 * Returns empty array on ALL/CANONICAL (no group layer there).
	 * The "All" pseudo-group is always present alongside functional groups.
	 */
	#computeGroups(): Group[] {
		const activeProvider = this.#getActiveProvider();
		if (activeProvider === ALL_TAB || activeProvider === CANONICAL_TAB) {
			return [];
		}
		const scopedItems = this.#allModels.filter(m => m.provider.toUpperCase() === activeProvider);
		const presentCategories = new Set<GroupCategory>();
		for (const item of scopedItems) {
			const cat = item.model.category as GroupCategory | undefined;
			if (cat) presentCategories.add(cat);
		}
		// Always show "All" as the last group; only include functional groups that have at least one model.
		const present: Group[] = [];
		for (const g of FUNCTIONAL_GROUPS) {
			if (g.categories.some(c => presentCategories.has(c))) {
				present.push(g);
			}
		}
		present.push(ALL_GROUP);
		return present;
	}

	/**
	 * Pinned models scoped to the current provider (or all if on ALL/CANONICAL).
	 * Order matches the user's pinned order from settings.
	 */
	#computePinnedItems(): ModelItem[] {
		const pinnedKeys = this.#settings.getPinned();
		if (pinnedKeys.length === 0) return [];
		const activeProvider = this.#getActiveProvider();
		const byKey = new Map<string, ModelItem>();
		for (const item of this.#allModels) {
			byKey.set(`${item.provider}/${item.id}`, item);
		}
		const out: ModelItem[] = [];
		for (const key of pinnedKeys) {
			const item = byKey.get(key);
			if (!item) continue;
			if (activeProvider !== ALL_TAB && activeProvider !== CANONICAL_TAB) {
				if (item.provider.toUpperCase() !== activeProvider) continue;
			}
			out.push(item);
		}
		return out;
	}

	async #refreshSelectedProvider(): Promise<void> {
		const activeProvider = this.#getActiveProvider();
		if (this.#scopedModels.length > 0 || activeProvider === ALL_TAB || activeProvider === CANONICAL_TAB) {
			return;
		}
		await this.#modelRegistry.refreshProvider(activeProvider.toLowerCase());
		await this.#loadModels();
		this.#buildProviderTabs();
		this.#updateTabBar();
		this.#applyTabFilter();
		this.#tui.requestRender();
	}

	#updateTabBar(): void {
		this.#headerContainer.clear();

		const tabs: Tab[] = this.#providers.map(provider => ({ id: provider, label: provider }));
		const tabBar = new TabBar("Models", tabs, getTabBarTheme(), this.#activeTabIndex);
		tabBar.onTabChange = (_tab, index) => {
			this.#activeTabIndex = index;
			this.#selectedIndex = 0;
			this.#layer = "provider";
			this.#activeGroupIndex = 0;
			// Rebuild both the provider tab bar AND the group tab bar for the
			// new provider. The group bar is only attached to the header inside
			// #updateTabBar; without this call it would stay empty on providers
			// entered after initial mount.
			this.#updateTabBar();
			this.#applyTabFilter();
			this.#refreshGroupsAndList();
			this.#updateList();
			this.#tui.requestRender();
			void this.#refreshSelectedProvider().catch(error => {
				this.#errorMessage = error instanceof Error ? error.message : String(error);
				this.#updateList();
				this.#tui.requestRender();
			});
		};
		this.#tabBar = tabBar;
		this.#headerContainer.addChild(tabBar);

		// Recompute groups for the new provider and render a second tab bar.
		this.#groups = this.#computeGroups();
		if (this.#activeGroupIndex >= this.#groups.length) {
			this.#activeGroupIndex = 0;
		}
		if (this.#groups.length > 0) {
			const groupTabs: Tab[] = this.#groups.map(g => ({ id: g.id, label: g.label }));
			const groupBar = new TabBar("Groups", groupTabs, getTabBarTheme(), this.#activeGroupIndex);
			groupBar.onTabChange = (_tab, index) => {
				this.#activeGroupIndex = index;
				this.#selectedIndex = 0;
				this.#rebuildVisibleItems();
				this.#updateList();
				this.#tui.requestRender();
			};
			this.#groupTabBar = groupBar;
			this.#headerContainer.addChild(new Spacer(1));
			this.#headerContainer.addChild(groupBar);
		} else {
			this.#groupTabBar = null;
		}
	}

	/** Recompute groups + pinned + visible items after provider or model list change. */
	#refreshGroupsAndList(): void {
		this.#groups = this.#computeGroups();
		if (this.#activeGroupIndex >= this.#groups.length) {
			this.#activeGroupIndex = 0;
		}
		this.#rebuildVisibleItems();
	}

	/**
	 * Build the list shown in the list layer:
	 * pinned section (if any) + group-filtered models.
	 * When on ALL/CANONICAL or no group is active, just the filtered models.
	 */
	#rebuildVisibleItems(): void {
		const isCanonical = this.#isCanonicalTab();
		this.#pinnedItems = isCanonical ? [] : this.#computePinnedItems();
		if (isCanonical) {
			this.#visibleItems = this.#filteredCanonicalModels;
			return;
		}
		const group = this.#groups[this.#activeGroupIndex];
		const pinnedKeys = new Set(this.#pinnedItems.map(i => `${i.model.provider}/${i.model.id}`));
		const groupFiltered =
			group && group.categories.length > 0
				? this.#filteredModels.filter(m => {
						const cat = m.model.category as GroupCategory | undefined;
						if (cat === undefined || !group.categories.includes(cat)) return false;
						// Exclude items already in the pinned section.
						return !pinnedKeys.has(`${m.model.provider}/${m.model.id}`);
					})
				: this.#filteredModels.filter(m => !pinnedKeys.has(`${m.model.provider}/${m.model.id}`));
		this.#visibleItems = [...this.#pinnedItems, ...groupFiltered];
	}

	#getActiveProvider(): string {
		return this.#providers[this.#activeTabIndex] ?? ALL_TAB;
	}

	#isCanonicalTab(): boolean {
		return this.#getActiveProvider() === CANONICAL_TAB;
	}

	#filterModels(query: string): void {
		const activeProvider = this.#getActiveProvider();
		const isCanonicalTab = activeProvider === CANONICAL_TAB;

		// Start with all models or filter by provider/canonical view
		let baseModels = this.#allModels;
		const baseCanonicalModels = this.#canonicalModels;
		if (!isCanonicalTab && activeProvider !== ALL_TAB) {
			baseModels = this.#allModels.filter(m => m.provider.toUpperCase() === activeProvider);
		}

		// Apply fuzzy filter if query is present
		if (query.trim()) {
			// If user is searching from a provider tab, auto-switch to ALL to show global provider results.
			if (activeProvider !== ALL_TAB && !isCanonicalTab) {
				this.#activeTabIndex = 0;
				if (this.#tabBar && this.#tabBar.getActiveIndex() !== 0) {
					this.#tabBar.setActiveIndex(0);
					return;
				}
				this.#updateTabBar();
				baseModels = this.#allModels;
			}

			if (isCanonicalTab) {
				const alphaTokens = getAlphaSearchTokens(query);
				const alphaFiltered =
					alphaTokens.length === 0
						? baseCanonicalModels
						: baseCanonicalModels.filter(item =>
								alphaTokens.every(token => item.normalizedSearchText.includes(token)),
							);
				const compactQuery = compactSearchText(query);
				const substringFiltered =
					compactQuery.length === 0
						? alphaFiltered
						: alphaFiltered.filter(item => item.compactSearchText.includes(compactQuery));
				const fuzzySource =
					substringFiltered.length > 0
						? substringFiltered
						: alphaFiltered.length > 0
							? alphaFiltered
							: baseCanonicalModels;
				const fuzzyMatches = fuzzyFilter(fuzzySource, query, ({ searchText }) => searchText);
				this.#sortCanonicalModels(fuzzyMatches);
				this.#filteredCanonicalModels = fuzzyMatches;
			} else {
				const fuzzyMatches = fuzzyFilter(baseModels, query, ({ id, provider }) => `${id} ${provider}`);
				this.#sortModels(fuzzyMatches);
				this.#filteredModels = fuzzyMatches;
			}
		} else {
			this.#filteredModels = baseModels;
			this.#filteredCanonicalModels = baseCanonicalModels;
		}

		const visibleCount = isCanonicalTab ? this.#filteredCanonicalModels.length : this.#filteredModels.length;
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, visibleCount - 1));
		this.#rebuildVisibleItems();
		this.#updateList();
	}

	#applyTabFilter(): void {
		const query = this.#searchInput.getValue();
		this.#filterModels(query);
	}

	#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {
		if (!fetchedAt) {
			return undefined;
		}
		const ageMs = Math.max(0, Date.now() - fetchedAt);
		if (ageMs < 60_000) {
			return "less than a minute ago";
		}
		const ageMinutes = Math.round(ageMs / 60_000);
		return `${ageMinutes}m ago`;
	}

	#getProviderEmptyStateMessage(): string | undefined {
		const activeProvider = this.#getActiveProvider();
		if (activeProvider === ALL_TAB || activeProvider === CANONICAL_TAB || this.#searchInput.getValue().trim()) {
			return undefined;
		}
		const state = this.#modelRegistry.getProviderDiscoveryState(activeProvider.toLowerCase());
		if (!state) {
			return undefined;
		}
		const age = this.#formatDiscoveryAge(state.fetchedAt);
		switch (state.status) {
			case "cached":
				return age
					? `  Using cached model list from ${age}. Live refresh is still pending.`
					: "  Using cached model list. Live refresh is still pending.";
			case "unavailable":
				return age ? `  Provider unavailable. Using cached model list from ${age}.` : "  Provider unavailable.";
			case "unauthenticated":
				return "  Provider requires authentication before models can be discovered.";
			case "idle":
				return "  Provider has not been refreshed yet.";
			case "ok":
				return "  Provider reported no models.";
		}
	}

	#updateList(): void {
		this.#listContainer.clear();
		const isCanonicalTab = this.#isCanonicalTab();
		const visibleItems = this.#visibleItems;
		const pinnedCount = isCanonicalTab ? 0 : this.#pinnedItems.length;

		const failures = loadModelFailures();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), visibleItems.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, visibleItems.length);

		const activeProvider = this.#getActiveProvider();
		const showProvider = activeProvider === ALL_TAB;

		// Pinned section header (rendered only when pinned items exist and are visible in the current window)
		if (pinnedCount > 0 && startIndex < pinnedCount) {
			this.#listContainer.addChild(new Text(theme.fg("accent", theme.bold("  \ud83d\udccc Pinned")), 0, 0));
		}

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = visibleItems[i];
			if (!item) continue;
			const canonicalItem = isCanonicalTab ? (item as CanonicalModelItem) : undefined;
			const providerItem = isCanonicalTab ? undefined : (item as ModelItem);

			const isSelected = i === this.#selectedIndex;

			// Build role badges (inverted: color as background, black text)
			const roleBadgeTokens: string[] = [];
			for (const role of MODEL_ROLE_IDS) {
				const { tag, color } = getRoleInfo(role, this.#settings);
				const assigned = this.#roles[role];
				if (!tag || !assigned || !modelsAreEqual(assigned.model, item.model)) continue;

				const badge = makeInvertedBadge(tag, color ?? "success");
				const thinkingLabel = getThinkingLevelMetadata(assigned.thinkingLevel).label;
				roleBadgeTokens.push(`${badge} ${theme.fg("dim", `(${thinkingLabel})`)}`);
			}
			// Custom role badges
			for (const [role, assigned] of Object.entries(this.#roles)) {
				if (role in MODEL_ROLES || !assigned || !modelsAreEqual(assigned.model, item.model)) continue;
				const roleInfo = getRoleInfo(role, this.#settings);
				const badgeLabel = roleInfo.tag ?? roleInfo.name;
				const badge = makeInvertedBadge(badgeLabel, roleInfo.color ?? "muted");
				const thinkingLabel = getThinkingLevelMetadata(assigned.thinkingLevel).label;
				roleBadgeTokens.push(`${badge} ${theme.fg("dim", `(${thinkingLabel})`)}`);
			}
			const badgeText = roleBadgeTokens.length > 0 ? ` ${roleBadgeTokens.join(" ")}` : "";

			// Model info string
			const info = theme.fg("dim", ` ${formatModelInfoString(item.model, failures)}`);

			let line = "";
			const emoji = emojiForCategory(item.model);
			const idWithEmoji = emoji ? `${emoji} ${item.id}` : item.id;
			if (isSelected) {
				const prefix = theme.fg("accent", `${theme.nav.cursor} `);
				if (isCanonicalTab) {
					const variants = theme.fg("dim", ` [${canonicalItem?.variantCount ?? 0}]`);
					const backing = theme.fg("dim", ` -> ${item.model.provider}/${item.model.id}`);
					line = `${prefix}${theme.fg("accent", idWithEmoji)}${variants}${backing}${info}${badgeText}`;
				} else if (showProvider) {
					const providerPrefix = theme.fg("dim", `${providerItem?.provider ?? ""}/`);
					line = `${prefix}${providerPrefix}${theme.fg("accent", providerItem?.id ?? idWithEmoji)}${info}${badgeText}`;
				} else {
					line = `${prefix}${theme.fg("accent", idWithEmoji)}${info}${badgeText}`;
				}
			} else {
				const prefix = "  ";
				if (isCanonicalTab) {
					const variants = theme.fg("dim", ` [${canonicalItem?.variantCount ?? 0}]`);
					const backing = theme.fg("dim", ` -> ${item.model.provider}/${item.model.id}`);
					line = `${prefix}${idWithEmoji}${variants}${backing}${info}${badgeText}`;
				} else if (showProvider) {
					const providerPrefix = theme.fg("dim", `${providerItem?.provider ?? ""}/`);
					line = `${prefix}${providerPrefix}${providerItem?.id ?? idWithEmoji}${info}${badgeText}`;
				} else {
					line = `${prefix}${idWithEmoji}${info}${badgeText}`;
				}
			}

			this.#listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < visibleItems.length) {
			const scrollInfo = theme.fg("muted", `  (${this.#selectedIndex + 1}/${visibleItems.length})`);
			this.#listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		if (this.#errorMessage) {
			const errorLines = String(this.#errorMessage).split("\n");
			for (const line of errorLines) {
				this.#listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (visibleItems.length === 0) {
			const statusMessage = this.#getProviderEmptyStateMessage();
			this.#listContainer.addChild(new Text(theme.fg("muted", statusMessage ?? "  No matching models"), 0, 0));
		}
	}
	#getThinkingLevelsForModel(model: Model): ReadonlyArray<ThinkingLevel> {
		return [ThinkingLevel.Inherit, ThinkingLevel.Off, ...getSupportedEfforts(model)];
	}

	#getCurrentRoleThinkingLevel(role: string): ThinkingLevel {
		return this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit;
	}

	#getThinkingPreselectIndex(role: string, model: Model): number {
		const options = this.#getThinkingLevelsForModel(model);
		const currentLevel = this.#getCurrentRoleThinkingLevel(role);
		const foundIndex = options.indexOf(currentLevel);
		return foundIndex >= 0 ? foundIndex : 0;
	}

	#getSelectedItem(): ModelItem | CanonicalModelItem | undefined {
		return this.#visibleItems[this.#selectedIndex];
	}

	#openMenu(): void {
		if (!this.#getSelectedItem()) return;

		this.#isMenuOpen = true;
		this.#menuStep = "role";
		this.#menuSelectedRole = null;
		this.#menuSelectedIndex = 0;
		this.#updateMenu();
	}

	#closeMenu(): void {
		this.#isMenuOpen = false;
		this.#menuStep = "role";
		this.#menuSelectedRole = null;
		this.#menuContainer.clear();
	}

	#updateMenu(): void {
		this.#menuContainer.clear();

		const selectedItem = this.#getSelectedItem();
		if (!selectedItem) return;

		const showingThinking = this.#menuStep === "thinking" && this.#menuSelectedRole !== null;
		const thinkingOptions = showingThinking ? this.#getThinkingLevelsForModel(selectedItem.model) : [];
		const pinLabel = showingThinking ? null : this.#getPinMenuLabel();
		const roleActionsForRender = showingThinking
			? []
			: this.#menuRoleActions.map((action, index) => ({ ...action, _renderIndex: pinLabel ? index + 1 : index }));
		const optionLines = showingThinking
			? thinkingOptions.map((thinkingLevel, index) => {
					const prefix = index === this.#menuSelectedIndex ? `  ${theme.nav.cursor} ` : "    ";
					const label = getThinkingLevelMetadata(thinkingLevel).label;
					return `${prefix}${label}`;
				})
			: (() => {
					const lines: string[] = [];
					if (pinLabel) {
						const prefix = this.#menuSelectedIndex === 0 ? `  ${theme.nav.cursor} ` : "    ";
						lines.push(`${prefix}${pinLabel}`);
					}
					for (const action of roleActionsForRender) {
						const prefix = action._renderIndex === this.#menuSelectedIndex ? `  ${theme.nav.cursor} ` : "    ";
						lines.push(`${prefix}${action.label}`);
					}
					return lines;
				})();

		const selectedRoleName = this.#menuSelectedRole ? getRoleInfo(this.#menuSelectedRole, this.#settings).name : "";
		const headerText =
			showingThinking && this.#menuSelectedRole
				? `  Thinking for: ${selectedRoleName} (${selectedItem.id})`
				: `  Action for: ${selectedItem.id}`;
		const hintText = showingThinking ? "  Enter: confirm  Esc: back" : "  Enter: continue  Esc: cancel";
		const menuWidth = Math.max(
			visibleWidth(headerText),
			visibleWidth(hintText),
			...optionLines.map(line => visibleWidth(line)),
		);

		this.#menuContainer.addChild(new Spacer(1));
		this.#menuContainer.addChild(new Text(theme.fg("border", theme.boxSharp.horizontal.repeat(menuWidth)), 0, 0));
		if (showingThinking && this.#menuSelectedRole) {
			this.#menuContainer.addChild(
				new Text(
					theme.fg("text", `  Thinking for: ${theme.bold(selectedRoleName)} (${theme.bold(selectedItem.id)})`),
					0,
					0,
				),
			);
		} else {
			this.#menuContainer.addChild(new Text(theme.fg("text", `  Action for: ${theme.bold(selectedItem.id)}`), 0, 0));
		}
		this.#menuContainer.addChild(new Spacer(1));

		for (let i = 0; i < optionLines.length; i++) {
			const lineText = optionLines[i];
			if (!lineText) continue;
			const isSelected = i === this.#menuSelectedIndex;
			const line = isSelected ? theme.fg("accent", lineText) : theme.fg("muted", lineText);
			this.#menuContainer.addChild(new Text(line, 0, 0));
		}

		this.#menuContainer.addChild(new Spacer(1));
		this.#menuContainer.addChild(new Text(theme.fg("dim", hintText), 0, 0));
		this.#menuContainer.addChild(new Text(theme.fg("border", theme.boxSharp.horizontal.repeat(menuWidth)), 0, 0));
	}

	handleInput(keyData: string): void {
		if (this.#isMenuOpen) {
			this.#handleMenuInput(keyData);
			return;
		}

		// 3-layer state machine: layer-specific key handling.
		if (this.#layer === "list") {
			this.#handleListInput(keyData);
			return;
		}
		if (this.#layer === "group") {
			this.#handleGroupInput(keyData);
			return;
		}
		// Layer = provider
		this.#handleProviderInput(keyData);
	}

	#handleProviderInput(keyData: string): void {
		// Tab/Right/Shift+Tab/Left cycle provider tabs
		if (this.#tabBar?.handleInput(keyData)) {
			return;
		}
		// Down or Enter: advance to next layer (group if available, else list)
		if (
			matchesKey(keyData, "down") ||
			matchesKey(keyData, "enter") ||
			matchesKey(keyData, "return") ||
			keyData === "\n"
		) {
			if (this.#groups.length > 0) {
				this.#layer = "group";
			} else {
				this.#layer = "list";
				this.#selectedIndex = 0;
				this.#updateList();
			}
			this.#tui.requestRender();
			return;
		}
		// Escape or Ctrl+C - close selector
		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			this.#onCancelCallback();
			return;
		}
		// Anything else: search input
		this.#searchInput.handleInput(keyData);
		this.#filterModels(this.#searchInput.getValue());
	}

	#handleGroupInput(keyData: string): void {
		// Tab/Right/Shift+Tab/Left cycle group tabs
		if (this.#groupTabBar?.handleInput(keyData)) {
			return;
		}
		// Down or Enter: advance to list layer
		if (
			matchesKey(keyData, "down") ||
			matchesKey(keyData, "enter") ||
			matchesKey(keyData, "return") ||
			keyData === "\n"
		) {
			this.#layer = "list";
			this.#selectedIndex = 0;
			this.#updateList();
			this.#tui.requestRender();
			return;
		}
		// Up: back to provider layer
		if (matchesKey(keyData, "up")) {
			this.#layer = "provider";
			this.#tui.requestRender();
			return;
		}
		// Escape: back to provider layer
		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			this.#layer = "provider";
			this.#tui.requestRender();
			return;
		}
		// Anything else: search input
		this.#searchInput.handleInput(keyData);
		this.#filterModels(this.#searchInput.getValue());
	}

	#handleListInput(keyData: string): void {
		// Tab/Right/Shift+Tab/Left cycle group tabs (when a group bar exists).
		// On ALL/CANONICAL there is no group bar, so fall through to provider.
		if (this.#groupTabBar && this.#groupTabBar.handleInput(keyData)) {
			return;
		}
		if (!this.#groupTabBar && this.#tabBar?.handleInput(keyData)) {
			return;
		}
		// Up arrow - navigate list (wrap to bottom when at top)
		if (matchesKey(keyData, "up")) {
			if (this.#visibleItems.length === 0) return;
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#visibleItems.length - 1 : this.#selectedIndex - 1;
			this.#updateList();
			return;
		}
		// Down arrow - navigate list (wrap to top when at bottom)
		if (matchesKey(keyData, "down")) {
			if (this.#visibleItems.length === 0) return;
			this.#selectedIndex = this.#selectedIndex === this.#visibleItems.length - 1 ? 0 : this.#selectedIndex + 1;
			this.#updateList();
			return;
		}
		// Enter - open context menu or select directly in temporary mode
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selectedItem = this.#visibleItems[this.#selectedIndex];
			if (!selectedItem) return;
			if (this.#temporaryOnly) {
				this.#handleSelect(selectedItem as ModelItem, null);
			} else {
				this.#openMenu();
			}
			return;
		}
		// Escape: back to previous layer (group if available, else provider)
		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			if (this.#groups.length > 0) {
				this.#layer = "group";
			} else {
				this.#layer = "provider";
			}
			this.#tui.requestRender();
			return;
		}
		// Anything else: search input
		this.#searchInput.handleInput(keyData);
		this.#filterModels(this.#searchInput.getValue());
	}
	#handleMenuInput(keyData: string): void {
		const selectedItem = this.#getSelectedItem();
		if (!selectedItem) return;

		const optionCount =
			this.#menuStep === "thinking" && this.#menuSelectedRole !== null
				? this.#getThinkingLevelsForModel(selectedItem.model).length
				: this.#menuRoleActions.length + (this.#getPinMenuLabel() ? 1 : 0);
		if (optionCount === 0) return;

		if (matchesKey(keyData, "up")) {
			this.#menuSelectedIndex = (this.#menuSelectedIndex - 1 + optionCount) % optionCount;
			this.#updateMenu();
			return;
		}

		if (matchesKey(keyData, "down")) {
			this.#menuSelectedIndex = (this.#menuSelectedIndex + 1) % optionCount;
			this.#updateMenu();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			if (this.#menuStep === "role") {
				const pinLabel = this.#getPinMenuLabel();
				if (pinLabel && this.#menuSelectedIndex === 0) {
					const key = this.#getSelectedModelKey();
					if (key) this.#settings.togglePinned(key);
					this.#rebuildVisibleItems();
					this.#closeMenu();
					this.#updateList();
					this.#tui.requestRender();
					return;
				}
				const roleIndex = pinLabel ? this.#menuSelectedIndex - 1 : this.#menuSelectedIndex;
				const action = this.#menuRoleActions[roleIndex];
				if (!action) return;
				this.#menuSelectedRole = action.role;
				this.#menuStep = "thinking";
				this.#menuSelectedIndex = this.#getThinkingPreselectIndex(action.role, selectedItem.model);
				this.#updateMenu();
				return;
			}

			if (!this.#menuSelectedRole) return;
			const thinkingOptions = this.#getThinkingLevelsForModel(selectedItem.model);
			const thinkingLevel = thinkingOptions[this.#menuSelectedIndex];
			if (!thinkingLevel) return;
			this.#handleSelect(selectedItem, this.#menuSelectedRole, thinkingLevel);
			this.#closeMenu();
			return;
		}

		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			if (this.#menuStep === "thinking" && this.#menuSelectedRole !== null) {
				this.#menuStep = "role";
				const roleIndex = this.#menuRoleActions.findIndex(action => action.role === this.#menuSelectedRole);
				this.#menuSelectedRole = null;
				this.#menuSelectedIndex = roleIndex >= 0 ? roleIndex : 0;
				this.#updateMenu();
				return;
			}
			this.#closeMenu();
			return;
		}
	}

	#handleSelect(item: ModelItem | CanonicalModelItem, role: string | null, thinkingLevel?: ThinkingLevel): void {
		// For temporary role, don't save to settings - just notify caller
		if (role === null) {
			this.#onSelectCallback(item.model, null, undefined, item.selector);
			return;
		}

		const selectedThinkingLevel = thinkingLevel ?? this.#getCurrentRoleThinkingLevel(role);

		// Update local state for UI
		this.#roles[role] = { model: item.model, thinkingLevel: selectedThinkingLevel };

		// Notify caller (for updating agent state if needed)
		this.#onSelectCallback(item.model, role, selectedThinkingLevel, item.selector);

		// Update list to show new badges
		this.#updateList();
	}

	getSearchInput(): Input {
		return this.#searchInput;
	}
}

/** Extract the first version number from a model ID (e.g. "gemini-2.5-pro" → 2.5, "claude-sonnet-4-6" → 4.6). */
function extractVersionNumber(id: string): number {
	// Dot-separated version: "gemini-2.5-pro" → 2.5
	const dotMatch = id.match(/(?:^|[-_])(\d+\.\d+)/);
	if (dotMatch) return Number.parseFloat(dotMatch[1]);
	// Dash-separated short segments: "claude-sonnet-4-6" → 4.6, "llama-3-1-8b" → 3.1
	const dashMatch = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
	if (dashMatch) return Number.parseFloat(`${dashMatch[1]}.${dashMatch[2]}`);
	// Single number after separator: "gpt-4o" → 4
	const singleMatch = id.match(/(?:^|[-_])(\d+)/);
	if (singleMatch) return Number.parseFloat(singleMatch[1]);
	return 0;
}
