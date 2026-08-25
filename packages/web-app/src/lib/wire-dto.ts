/**
 * 前端协议 DTO —— P0 过渡 shim。
 *
 * 全部类型已迁往 @oh-my-pi/pi-wire（results/ 按领域 + snapshot.ts + frames.ts）。
 * 本文件仅 re-export 保持 web-app 既有 import 不断；删除本文件并改 10 个引用
 * 的 import 路径列入 P0 收尾（web-app 直连 pi-wire）。
 */
export * from "@oh-my-pi/pi-wire";
