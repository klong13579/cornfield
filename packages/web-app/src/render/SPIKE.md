# R1a — markdown 管线 spike 结论

> 2026-08-17 · W2 渲染线 · 卡片结论落档（react-markdown 全链，不降级）

## 路线

**采用**：`react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` + `rehype-highlight`。

**不采用**：`marked` + `DOMPurify` 降级（react-markdown 构建 React 元素而非 innerHTML，
XSS 天然安全，无需 DOMPurify）。

## 已验证（Tailwind 4 + Vite 6 + React 19）

| 项目 | 结论 |
|------|------|
| KaTeX CSS/字体 | `import "katex/dist/katex.min.css"` 正常，woff/woff2/ttf 由 Vite 产出并随 CSS 按需拉取 |
| preflight × highlight | highlight.js `github` 主题 + `.md` 命名空间把 `.hljs` 收敛为「只上色」，容器归 `.md pre` |
| GFM | 表格 / 删除线 / 任务列表 / 自动链接全部 DOM 冒烟通过 |
| 行内/块级数学 | `$…$` 与 `$$…$$` 均渲染出 `.katex` |

## bundle 结论

- react-markdown + katex + hljs 全量 = **~183KB gzip**，必须 lazy 切出主包。
- R1b 采用 `React.lazy(() => import("./MarkdownRenderer"))`，主包增量 +0.37KB gzip。
- 同款 lazy 策略向前复用：R2 mermaid（~155KB gzip）独立 lazy chunk。