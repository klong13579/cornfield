import "./monaco-env";
import "@opensumi/ide-i18n/lib/browser";
import "@opensumi/ide-core-browser/lib/style/index.less";
import "@opensumi/ide-core-browser/lib/style/icon.less";
import { AILayout } from "@opensumi/ide-ai-native/lib/browser/layout/ai-layout";
import { OMP_THEME_ID, resolveOmpAgent } from "./agent-config";
import { AIModules, CommonBrowserModules } from "./common-modules";
import { layoutConfig } from "./layout-config";
import { renderApp } from "./render-app";
import "./main.less";
import "./styles.less";

renderApp({
	modules: [...CommonBrowserModules, ...AIModules],
	layoutConfig,
	layoutComponent: AILayout,
	useCdnIcon: false,
	defaultPreferences: {
		"general.theme": OMP_THEME_ID,
		"general.icon": "vscode-icons",
		// omp agent 正规注册：默认 agent 类型 + agent 目录 + spawn 覆盖，三者齐备（非 provider patch）。
		"ai.native.agent.defaultType": "omp",
		"ai.native.agent.configs": {
			omp: { ...resolveOmpAgent(), streaming: true, description: "OMP Agent (oh-my-pi)" },
		},
		"ai-native.acp.agents": {
			omp: { ...resolveOmpAgent(), description: "OMP Agent (oh-my-pi)" },
		},
	},
	designLayout: {
		useMenubarView: true,
		useMergeRightWithLeftPanel: true,
	},
	defaultPanels: {
		bottom: "@opensumi/ide-terminal-next",
		right: "",
	},
});
