# Zed fork —— Zomp 嵌入式编辑器组件

本目录是 [zed-industries/zed](https://github.com/zed-industries/zed) 的 fork，
作为 Zomp（OMP 桌面客户端）的嵌入式编辑器组件。上游 README 见 `README.md`。

## 来源与版本

- 上游基线：`zed main @ 10b2925e7c`（docs: Document language auto-indentation rules (#63009)）
- 当前分支：`spike/embedded-p0`（2 个本地提交）
- 本地开发源：`/Users/sz-0203015357/Desktop/Narwal/zed`（含完整 git 历史）
- 同步策略：**季度 rebase 上游**，冲突集中在 `crates/gpui` 与 `crates/gpui_macos` 两个 crate（约几十行侵入改动）

## 许可证

**GPL-3.0**。本目录是 GPL 衍生代码域，与 oh-my-pi 主仓库的 MIT 域隔离：

- 本目录（及任何依赖 gpui 的壳代码）受 GPL-3.0 约束（见 `LICENSE-GPL`）
- oh-my-pi 根 Cargo workspace（MIT）**不得**将本目录 crate 纳入 members
- 根 `Cargo.toml` `members = ["crates/*"]` 天然不匹配 `third_party/zed`，勿改

## 结构

- 独立 Cargo workspace（自带 `Cargo.toml` + `rust-toolchain.toml`，锁 Rust 1.97.1）
- 侵入改动仅两处（相对上游）：
  - `crates/gpui`：`WindowOptions`/`WindowParams` 增加 macos-only `embedded_in: Option<*mut c_void>`
  - `crates/gpui_macos`：`MacWindow::open` 将 GPUIView 挂到宿主 view；display link 可见性以 GPUIView 实际所在窗口（宿主窗口）的 `isVisible` 判定；GPUIView `dealloc` 时停 display link 并标记 `native_view` 失效（宿主窗口先销毁不崩）
- `crates/omp_embed_spike`：P0 验证程序（宿主 NSWindow + GPUIView 内嵌渲染/事件/节流）

## 验证状态（P0 通过 + T1 稳定化）

- 渲染：宿主 NSWindow 内 GPUIView 渲染，OCR 确认文字内容
- 事件：真实鼠标点击经 AppKit sendEvent → GPUIView → gpui 分发，计数实时渲染
- 节流：宿主窗口隐藏 → display link 停止；可见 → 恢复
- 生命周期（T1）：宿主窗口先于 gpui 窗口销毁时，GPUIView `dealloc` 停 display link（cancel dispatch source，`step` 不再触发）并标记 `native_view` 失效，后续 `start_display_link` / 光标更新短路，不 crash
- 约束：宿主窗口须在 `application().run` 后创建；CanJoinAllSpaces 窗口 occlusionState 不可靠（0x2000），embedded 用 `isVisible`；normal 模式保留 occlusion 判定（无回归）

## 开发

```bash
# 编译验证（本机 CLT 无 Xcode，需 runtime_shaders 特性绕开 xcrun metal）
cd third_party/zed
cargo check -p omp_embed_spike   # 或 cargo build -p omp_embed_spike

# 运行 spike（GUI 会话）
OMP_SPIKE_VERIFY=1 ./target/debug/omp_embed_spike
```

实验开关：`OMP_SPIKE_NORMAL`（普通窗口对照）、`OMP_SPIKE_BADORDER`（坏初始化顺序，应 panic）、`OMP_SPIKE_SYNCSEND`（锁内同步 sendEvent，已证安全）、`OMP_SPIKE_AUTOCLICK`（GCD 注入合成点击）。
