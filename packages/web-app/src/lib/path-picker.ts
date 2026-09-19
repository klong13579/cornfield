/**
 * 「选一个目录」的答复形状与调用形状 —— 这个概念在渲染层的**唯一一份**声明。
 *
 * 一个目录选择器只有**拥有那个文件系统**的一方弹得出来，所以有两条通路：
 *   - 桌面壳（Electron）用系统原生对话框（`dialog:pick-directory`，见 `desktop-bridge`）；
 *   - 网页直开（`cornfield serve` + 浏览器，没有壳）由 serve 弹（wire 的 `pick_directory`）。
 *
 * 为什么网页直开不能自己选：浏览器拿不到绝对路径 —— `<input type="file" webkitdirectory>` 只给
 * `webkitRelativePath`（相对），而 Project root 与工作目录要的都是**绝对路径**。所以「选目录」这件事
 * 只能交给真正拥有那个文件系统的进程。
 *
 * 两条通路回的是同一个形状，因为对调用方来说它们是同一个问题；哪条可用由调用方（控件）按
 * 「有壳优先」决定，不由这里猜。
 *
 * 三种结果不许揉成两种：选了 / 取消 / 弹不出来。前两种在这个类型里，第三种是**抛** ——
 * 选择器失败由调用方把原文显示出来（控件自留第二个错误界面，一次失败就会在页面上出现两处说法）。
 */

/** 目录选择器的答复。`canceled` 为真时没有 `path`：取消不是「选了个空路径」。 */
export type PickDirectoryResult = { canceled: true } | { canceled: false; path: string };

/** 目录选择器调用。`defaultPath` 只是起始位置建议：选不了那个位置就退到别处，不算错误。 */
export type DirectoryPicker = (defaultPath?: string) => Promise<PickDirectoryResult>;
