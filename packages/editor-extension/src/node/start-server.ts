import { Deferred } from "@opensumi/ide-core-common";
import { type IServerAppOpts, type NodeModule, ServerApp } from "@opensumi/ide-core-node";
import * as fs from "fs";
import * as http from "http";
import Koa from "koa";
import koaStatic from "koa-static";
import * as path from "path";

/**
 * 短 TMPDIR（spike 绕弯 3）：macOS 默认 TMPDIR 路径过长，watcher 进程的 unix socket
 * listen 会 EINVAL（sun_path 上限）。这里在启动前切换到短路径，避免 socket 创建失败。
 */
function ensureShortTmpDir(): void {
	const shortTmpDir = process.env.OMP_TMPDIR || "/tmp/omp-ide";
	process.env.TMPDIR = shortTmpDir;
	fs.mkdirSync(shortTmpDir, { recursive: true });
}

/**
 * SHELL 兑底（A7）：bun 的 os.userInfo().shell 在 macOS 上返回 "unknown"（不解析 passwd），
 * 且 bun 子进程可能不带 SHELL 环境变量——OpenSumi 终端默认 shell 探测（getSystemShellUnixLike）
 * 先看 SHELL 再退回 userInfo().shell，两者都不对时会把 "unknown" 当可执行文件，终端起不来。
 * 启动前兜底注入真实 shell。
 */
function ensureShellEnv(): void {
	process.env.SHELL ||= "/bin/zsh";
}

export async function startServer(arg1: NodeModule[] | Partial<IServerAppOpts>) {
	const app = new Koa();
	const deferred = new Deferred<http.Server>();
	ensureShortTmpDir();
	ensureShellEnv();
	process.env.EXT_MODE = "js";
	const port = process.env.IDE_SERVER_PORT || 8000;
	const workspaceDir = process.env.WORKSPACE_DIR || path.join(__dirname, "../../workspace");
	const extensionDir = process.env.EXTENSION_DIR || path.join(__dirname, "../../extensions");
	const extensionHost =
		process.env.EXTENSION_HOST_ENTRY ||
		(process.env.NODE_ENV === "production"
			? path.join(__dirname, "..", "..", "hosted/ext.process.js")
			: path.join(__dirname, "..", "..", "hosted/ext.process.js"));
	let opts: IServerAppOpts = {
		use: app.use.bind(app),
		processCloseExitThreshold: 5 * 60 * 1000,
		terminalPtyCloseThreshold: 5 * 60 * 1000,
		staticAllowOrigin: "*",
		staticAllowPath: [workspaceDir, extensionDir, "/"],
		extHost: extensionHost,
	};

	if (Array.isArray(arg1)) {
		opts = {
			...opts,
			modulesInstances: arg1,
		};
	} else {
		opts = {
			...opts,
			...arg1,
		};
	}

	const serverApp = new ServerApp(opts);
	const server = http.createServer(app.callback());

	if (process.env.NODE_ENV === "production") {
		app.use(koaStatic(path.join(__dirname, "../../dist")));
	}

	await serverApp.start(server);

	server.on("error", err => {
		deferred.reject(err);
		console.error(`Server error: ${err.message}`);
		setTimeout(process.exit, 0, 1);
	});

	server.listen(port, () => {
		console.log(`Server listen on port ${port}`);
		deferred.resolve(server);
	});
	return deferred.promise;
}
