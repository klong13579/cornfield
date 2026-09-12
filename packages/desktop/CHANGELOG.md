# Changelog

## [Unreleased]

## [1.1.4] - 2026-09-12

### Fixed

- **「重启更新」误装陈旧缓存包导致应用被打成坏版本**（`src/update.ts`, `src/main.ts`）：`installUpdate` 原直接取 updater 缓存里 mtime 最新的 zip、不校验版本，陈旧 pending（旧版下载残留）会永远点亮「重启更新」按钮，一点击就用旧包覆盖当前安装 —— 实测缓存遗留的 1.1.0 zip 把健康的 1.1.1 应用覆盖成缺 logger.js 的坏包（启动即崩）。新增更新包版本门禁：安装前读 zip 内 `CFBundleShortVersionString`，旧于当前版本或损坏读不出版本即拒绝并提示重新下载；`update:has-downloaded` 只认可用（版本 ≥ 当前）的 zip；下载成功后自动清理缓存里其它残留 zip（新旧目录均覆盖）。

- **桌面壳打包缺 `--bundle` 导致启动即崩**（`package.json` build）：esbuild 不带 `--bundle` 时只转译入口、不产出本地模块，`src/logger.ts`（1.1.0 加入）从未被打包；`dist/main.js` 保留 `import ... from "./logger.js"` 运行时引用，asar 内无该文件 → 主进程 ESM 链接阶段抛 `ERR_MODULE_NOT_FOUND`，1.1.0/1.1.1 桌面客户端一启动就崩且无日志可查。改为对 main/sidecar/preload 逐个 `--bundle --packages=external`：本地模块（logger）内联进 main.js，`electron`/`electron-updater` 保持 external 从 asar node_modules 解析；preload 改 `--outfile` 直出 `.cjs`，不再用 `--out-extension` hack。

## [1.1.1] - 2026-09-06

### Added

- **壳主进程文件日志**（`src/logger.ts`, `src/main.ts`）: GUI 方式启动（Finder/Dock）时 stderr 被系统丢弃，主进程 console 输出（updater 错误、sidecar 异常、加载失败）无处可查，「检查更新没反应」类问题无法留证。新增 `initFileLogging` 把 console.* 同步镜像到 `~/Library/Logs/<app>/main.log`（packaged: `CornField`，dev: `@cornfield/desktop`；5MB 轮转保留一代，Error 展开为单行）；`autoUpdater.logger` 接入同一文件，updater 内部 feed 检查/下载/校验日志不再丢失。候选目录按序回退（`app.getPath("logs")` → `userData/logs` → 仅 stderr 旧行为），并补齐启动/sidecar 状态/single-instance 拒绝/before-quit 生命周期日志。

## [1.1.0] - 2026-09-05

### Added

- **桌面壳初版**：托盘常驻 + sidecar（`cornfield serve`）探测/拉起/接管，web-app renderer 加载，electron-updater 手动检查/下载/自举安装流（`src/main.ts`, `src/sidecar.ts`, `src/preload.ts`）。
