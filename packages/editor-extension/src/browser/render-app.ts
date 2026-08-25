import { Injector } from "@opensumi/di";
import type { IClientAppOpts } from "@opensumi/ide-core-browser";
import { ClientApp } from "@opensumi/ide-core-browser/lib/bootstrap/app";
import { MyAgentContribution } from "./agent-view/my-agent.contribution";
import { ApprovalContribution } from "./approval/approval.contribution";
import { CeoWorkbenchContribution } from "./ceo/ceo-workbench.contribution";
import { ConfigContribution } from "./config/config.contribution";
import { CoreCommandContribution } from "./core-commands";
import { DiffContribution } from "./diff/diff.contribution";
import { DomainContribution } from "./domain/domain.contribution";
import { FileSystemContribution } from "./file-system/file-system.contribution";
import { GitContribution } from "./git/git.contribution";
import { OmpThemeContribution } from "./theme.contribution";
import { TraceContribution } from "./trace/trace.contribution";

export async function renderApp(opts: IClientAppOpts) {
	const injector = new Injector();
	injector.addProviders(OmpThemeContribution);
	injector.addProviders(CoreCommandContribution);
	injector.addProviders(FileSystemContribution);
	injector.addProviders(ConfigContribution);
	injector.addProviders(DiffContribution);
	injector.addProviders(DomainContribution);
	injector.addProviders(CeoWorkbenchContribution);
	injector.addProviders(TraceContribution);
	injector.addProviders(ApprovalContribution);
	injector.addProviders(MyAgentContribution);
	injector.addProviders(GitContribution);

	const hostname = window.location.hostname;
	const query = new URLSearchParams(window.location.search);
	// 线上的静态服务和 IDE 后端是同一个 Server
	const serverPort = process.env.DEVELOPMENT ? 8000 : window.location.port;
	const staticServerPort = process.env.DEVELOPMENT ? 8080 : window.location.port;
	const webviewEndpointPort = process.env.DEVELOPMENT ? 8899 : window.location.port;
	opts.workspaceDir = opts.workspaceDir || query.get("workspaceDir") || process.env.WORKSPACE_DIR;

	opts.extensionDir = opts.extensionDir || process.env.EXTENSION_DIR;
	// 票 07：OpenSumi 偏好持久化重定向 —— 不落 ~/.sumi 平台配置，改落 .omp-ide。
	// preferenceDirName 系列控制工作区配置目录，storageDirName 控制全局存储目录（默认均为 .sumi）。
	opts.storageDirName = opts.storageDirName || ".omp-ide";
	opts.preferenceDirName = opts.preferenceDirName || ".omp-ide";
	opts.workspacePreferenceDirName = opts.workspacePreferenceDirName || ".omp-ide";
	opts.injector = injector;
	opts.wsPath =
		process.env.WS_PATH ||
		(window.location.protocol === "https:" ? `wss://${hostname}:${serverPort}` : `ws://${hostname}:${serverPort}`);
	opts.extWorkerHost =
		opts.extWorkerHost ||
		process.env.EXTENSION_WORKER_HOST ||
		`http://${hostname}:${staticServerPort}/worker-host.js`;
	opts.staticServicePath = `http://${hostname}:${serverPort}`;
	const anotherHostName = process.env.WEBVIEW_HOST || hostname;
	opts.webviewEndpoint = `http://${anotherHostName}:${webviewEndpointPort}/webview`;
	const app = new ClientApp(opts);

	app.fireOnReload = () => {
		window.location.reload();
	};

	app.start(document.getElementById("main")!, "web");
}
