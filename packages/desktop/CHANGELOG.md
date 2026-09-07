# Changelog

## [Unreleased]

### Fixed

- **桌面壳打包缺 `--bundle` 导致启动即崩**（`package.json` build）：esbuild 不带 `--bundle` 时只转译入口、不产出本地模块，`src/logger.ts`（1.1.0 加入）从未被打包；`dist/main.js` 保留 `import ... from "./logger.js"` 运行时引用，asar 内无该文件 → 主进程 ESM 链接阶段抛 `ERR_MODULE_NOT_FOUND`，1.1.0/1.1.1 桌面客户端一启动就崩且无日志可查。改为对 main/sidecar/preload 逐个 `--bundle --packages=external`：本地模块（logger）内联进 main.js，`electron`/`electron-updater` 保持 external 从 asar node_modules 解析；preload 改 `--outfile` 直出 `.cjs`，不再用 `--out-extension` hack。

## [1.1.1] - 2026-09-06

### Added

- **壳主进程文件日志**（`src/logger.ts`, `src/main.ts`）: GUI 方式启动（Finder/Dock）时 stderr 被系统丢弃，主进程 console 输出（updater 错误、sidecar 异常、加载失败）无处可查，「检查更新没反应」类问题无法留证。新增 `initFileLogging` 把 console.* 同步镜像到 `~/Library/Logs/<app>/main.log`（packaged: `CornField`，dev: `@cornfield/desktop`；5MB 轮转保留一代，Error 展开为单行）；`autoUpdater.logger` 接入同一文件，updater 内部 feed 检查/下载/校验日志不再丢失。候选目录按序回退（`app.getPath("logs")` → `userData/logs` → 仅 stderr 旧行为），并补齐启动/sidecar 状态/single-instance 拒绝/before-quit 生命周期日志。

## [1.1.0] - 2026-09-05

### Added

- **桌面壳初版**：托盘常驻 + sidecar（`cornfield serve`）探测/拉起/接管，web-app renderer 加载，electron-updater 手动检查/下载/自举安装流（`src/main.ts`, `src/sidecar.ts`, `src/preload.ts`）。
