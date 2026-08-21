import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	// base: "./"：产物用相对路径（./assets/...），Electron 壳 loadFile(file://) 加载时
	// 绝对路径 /assets/ 会解析到文件系统根目录导致白屏。dev server 下相对路径同样可用。
	base: "./",
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		strictPort: false,
	},
});
