// monaco worker 本地化：next 通道的 CDN worker 路径 404，改为加载本地 bundle。
//
// 必须在 OpenSumi `MonacoClientContribution.registerMonacoEnvironment()` 之前执行：
// 该方法内部有 `if (!window.MonacoEnvironment)` 保护，先在此设置则不会被覆盖。
// `editor.worker.bundle.js` 由 webpack CopyPlugin 从 `@opensumi/ide-monaco/worker/` 复制到 dist 根目录。

function setupMonacoWorker(): void {
	const w = window as unknown as { MonacoEnvironment?: unknown };
	if (!w.MonacoEnvironment) {
		w.MonacoEnvironment = {
			getWorker: (_workerId: string, label: string) =>
				new Worker("/editor.worker.bundle.js", { type: "classic", name: label }),
		};
	}
}

setupMonacoWorker();
