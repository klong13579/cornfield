# 用 grill-me 替换 ask 工具的实施计划

## 背景

`ask` 是系统内置 Tool(789 行 TS),在 `BUILTIN_TOOLS` 注册,提供结构化选择器(上下键、多选、超时、Plan Mode 集成)。`grill-me` 是 Skill(纯文本指令),通过 LLM 自然语言行为实现多轮提问,能在 headless/IM 场景下工作。

用户设计意图:grill-me 作为通用意图澄清机制,按意图分派不同策略,替换 ask 的默认注册。ask 保留代码但不引用(非 Plan Mode),等 grill-me 验证达标后再物理删除。

## 已完成

- grilling/SKILL.md 已重写,加入意图分派(user/task/design)三分支 — 文件在 `~/.omp/agent/skills/grilling/SKILL.md`,已保留

## 待实施(7 项改动)

### 1. grilling/SKILL.md — 已完成,无需再改

### 2. packages/coding-agent/src/tools/index.ts — 三处改动

**2a. 删除 import(第 22 行)**
```typescript
// 删除:
import { AskTool } from "./ask";
```

**2b. 删除 BUILTIN_TOOLS 注册(第 223 行)**
```typescript
// 删除:
ask: AskTool.createIf,
```

**2c. isToolAllowed 加 Plan Mode 守卫(第 404 行,函数体内第一行)**
```typescript
const isToolAllowed = (name: string) => {
    if (name === "ask") return session.getPlanModeState?.()?.enabled ?? false;
    // ... 其余不变
```

### 3. packages/coding-agent/test/tools/index.test.ts — 改测试(第 189-203 行)

原测试:
```typescript
it("excludes ask tool when hasUI is false", async () => {
    const session = createTestSession({ hasUI: false });
    const tools = await createTools(session);
    const names = tools.map(t => t.name);
    expect(names).not.toContain("ask");
});

it("includes ask tool when hasUI is true", async () => {
    const session = createTestSession({ hasUI: true });
    const tools = await createTools(session);
    const names = tools.map(t => t.name);
    expect(names).toContain("ask");
});
```

替换为:
```typescript
it("excludes ask tool when not in Plan Mode", async () => {
    const session = createTestSession({ hasUI: true });
    const tools = await createTools(session);
    const names = tools.map(t => t.name);
    expect(names).not.toContain("ask");
});

it("includes ask tool when in Plan Mode", async () => {
    const session = createTestSession({
        hasUI: true,
        getPlanModeState: () => ({ enabled: true, planFilePath: "/tmp/plan.md" }),
    });
    const tools = await createTools(session);
    const names = tools.map(t => t.name);
    expect(names).toContain("ask");
});
```

> PlanModeState 类型定义在 `packages/coding-agent/src/plan-mode/state.ts`,必填字段:`enabled: boolean`, `planFilePath: string`。

### 4-7. 不改动的文件

| 文件 | 理由 |
|---|---|
| `tools/ask.ts` | 保留,Plan Mode 下仍活跃 |
| `prompts/tools/ask.md` | 保留,Plan Mode 下仍活跃 |
| `config/settings-schema.ts` | `ask.timeout` / `ask.notify` 设置项保留 |
| `config/settings.ts` | ask.timeout 迁移逻辑保留 |
| `modes/components/settings-defs.ts` | 设置面板 UI 保留 |
| `prompts/system/plan-mode-active.md` | Plan Mode 下 ask 仍活跃,`{{askToolName}}` 引用不变 |
| `prompts/system/plan-mode-tool-decision-reminder.md` | 同上 |
| `session/agent-session.ts` | `askToolName: "ask"` 注入不变 |
| `prompts/system/_procedure.md` | `{{#has tools "ask"}}` Handlebars 分支自动适配 |
| `prompts/system/_contract.md` | 泛化约束,不指向 ask 工具 |
| `test/tools/ask.test.ts` | ask.ts 保留,测试仍有效 |
| `test/args.test.ts` | 只测参数解析,不涉及工具创建 |
| `~/.omp/agent/skills/grill-me/SKILL.md` | 不改,委托给 grilling |
| `~/.omp/agent/skills/grill-with-docs/SKILL.md` | 不改,引用 grilling 自动继承意图分派 |
| `~/.omp/agent/skills/grilling/grilling-template.md` | 不改,仅 user 意图时加载 |

## 验证

实施后运行:
```bash
bun test packages/coding-agent/test/tools/index.test.ts
bun test packages/coding-agent/test/tools/ask.test.ts
bun check:ts
```

## 设计决策记录(grilling 过程中确认)

1. **grill-me 定位**:通用意图澄清,不是画像采集。9 维模板仅 user 意图时加载
2. **意图分派**:LLM 自主判断(user/task/design),不拆成多个技能,不带参数
3. **ask 处理**:保留但不引用(非 Plan Mode),isToolAllowed 一行守卫
4. **Plan Mode**:保留 ask 作为最后消费者,等其他场景验证后再迁移
5. **TUI 交互**:纯自然语言,不保留结构化选择器
6. **system prompt**:不加"遇到决策用 grill-me"的引导,靠 grill-me description 承担触发判断
7. **设置项**:保留(不删 schema/UI),减少恢复成本
8. **测试**:ask.test.ts 保留,args.test.ts 不改,只改 index.test.ts 的两个断言
