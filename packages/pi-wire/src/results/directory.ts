/**
 * 目录选择的答复 —— 「让**跑 serve 的那台机器**上的人选一个目录」的结果。
 *
 * 与桌面壳的 `dialog:pick-directory` 同形（`web-app/src/lib/desktop-bridge.ts`）：它们是同一个
 * 概念的两条通路。选择器只有**拥有那个文件系统**的一方弹得出来 —— 浏览器拿不到绝对路径
 * （`<input type="file" webkitdirectory>` 只给 `webkitRelativePath`），所以网页直开时由 serve 弹。
 *
 * 三种结果不许揉成两种：
 *   - 选了 → `{ canceled: false, path }`（`path` 非空由弹选择器的那一方保证，空串不是一种成功）；
 *   - 取消 → `{ canceled: true }` —— 一次「什么都没发生」，不是一次空路径；
 *   - 弹不出来（没有 GUI 会话 / 平台没实现 / 系统选择器起不来）→ 命令 **ok:false + error**，
 *     不走 `canceled`。把「人根本没被问到」说成「人选了取消」就是替人编了一个决定。
 */
export type PickDirectoryDto = { canceled: true } | { canceled: false; path: string };
