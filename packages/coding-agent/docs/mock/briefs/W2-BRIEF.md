# W2 渲染线任务卡

你是并行开发三线之一的 W2（渲染）。工作目录：/Users/sz-0203015357/Desktop/Narwal/oh-my-pi/.worktrees/hermes-fusion
分支：w2-render（从 hermes-fusion 切出）
总计划：docs/mock/HERMES_FUSION_PLAN.md（先通读）

## 你的独占文件
components/（现有+新增） render/（新建目录）

## 任务（按序）
- R5（1d，第一天必须交付 ContextRing 给 W1）：ContextRing（token 用量圆环，数据 session-store 的 tokenUsage）+ QueueCard（排队消息卡）+ SteerIndicator（steer 斜体指示条）
- R1a markdown spike（0.5d）：空页验证 react-markdown + remark-gfm + rehype-highlight + remark-math/katex 在 Tailwind 4 + Vite 6 跑通（katex 字体引入、preflight 冲突）。失败降级 marked+DOMPurify。结论写进 render/SPIKE.md
- R1b 管线正式接入（1d）：删 MarkdownLite.tsx
- R2 Mermaid.tsx（1d）：lazy import + 查看器（全屏/缩放）。规格抄 hermes ui.js:19522-2046（源码在 tmp/hermes-webui/static/ui.js，可读）
- R3 ActivityFold.tsx（1d）：thinking+全部工具收一行 "Activity: N tools"，展开态按 turn 存 localStorage，失败徽标例外露出。重写 Transcript/ToolCard/ThinkingFold 进 render/
- R4 MsgActions（1d）：hover 操作条 copy 立即通；undo/regenerate/fork 按钮先渲染禁用态（等 wire 命令）
- R6 ApprovalCard + ClarifyCard（1d）：UI 壳，props 定义好协议形状，数据先用组件默认值

## 视觉基准
docs/mock/v8-hermes-full.html（黑白 zinc）。转录区形态：role-icon 圆头像 + 正文左缩进 30px + assistant 衬线体（Georgia）。

## 纪律
- 不动 layout/ router.tsx pages/ state/ lib/ serve
- 每卡：biome + tsgo 干净才提交；提交前 rebase hermes-fusion
