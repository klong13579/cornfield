# TODO

> Current task state. The agent updates this file as work progresses; an empty TODO is a valid state.

## 待办

<!-- 新增待办：使用 - [ ] <text> 格式追加在下面这一行之后 -->

- [ ] 审视 system prompt token 优化路径：cold start input ~37k → 22-23k 的可压空间（mcp 工具按需 / skills 死代码清理 / SYSTEM.md 拆按需 references）
- [ ] scheduler 模块遗留改动 review：cron-service / diagnostics / index / types 四个文件尚未提交，确认改动方向
- [ ] 给 omp 增加 project-level TODO 显示（welcome 下方增加一个可关闭的 TODO 面板），覆盖文件缺失、解析失败、宽度过窄等边界

## 已完成

- [x] 新建仓库根 TODO.md，定义 `## 待办` 段落与 `- [ ]` 写入约定
- [x] 在 `packages/coding-agent/src/modes/components/todo-header.ts` 实现 TODO 头部组件与 markdown 解析器
- [x] 在 `InteractiveMode.init()` 中把 `TodoHeaderComponent` 挂到 welcome 之后
- [x] 在 AGENTS.md 增加 `## Project TODO` 规则：触发关键字 → 写入 `TODO.md`
