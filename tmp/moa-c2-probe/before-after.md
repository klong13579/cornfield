# C2 前后对比（对比一下 workbuddy 和 openclaw）

同一用例、同一 `moa.yml`（flash researchModel）、最新源码 `executePlan`。

| 指标 | Before (`14-12-22`) | After early-stop (`14-55-10`) | After tool-trace (`15-29-18`) | Rerun fix (`15-41-05`) |
|------|---------------------|------------------------------|------------------------------|------------------------|
| **总墙钟** | 1257s（~21.0 min） | 1144s（~19.1 min） | **444s（~7.4 min）** | 867s（~14.5 min） |
| Discovery | 30s | ~30s | 34s | 37s |
| **InputCollect (B)** | **38s**（跑了） | **0s（跳过）** | **0s（跳过）** | **0s（跳过）** |
| **Research** | **785s**，**0 sources**，salvage | **457s**，**20 sources**，salvage | **113s**，**8 sources**，**tool_trace** | **169s**，**8 sources**，**tool_trace** |
| Ask (grill×3) | 47s | ~47s 量级 | 74s | 35s |
| Rewrite | 55s（**解析失败 fallback**） | 89s（**成功**） | 114s（成功） | 91s（成功） |
| Workers | 255s，3/3 OK | **481s**，2/3（grounded **timeout 480s**） | **51s**，2/3（误触 budget abort） | **482s**，2/3（grounded **timeout 480s**） |
| Synthesis | 46s OK | 51s OK | 59s OK | 53s OK |

## 根因对照

| Before | After early-stop | After tool-trace | Rerun fix |
|--------|------------------|------------------|-----------|
| Research 搜满 8 次后空收尾 | Early-stop≈3 + 25s soft；工具轨迹 salvage 抽出 URL | URL≥3 → `signalEnoughEvidence`；定稿 `parse=tool_trace`，sources **cap 8** | 同左；`max=0` no-op + 只计 `web_search` URL |
| 对比题仍跑 B | `task_intent=compare` 跳过 InputCollect | 同左 | 同左 |
| pack 对下游无用 | 20 条 salvage 进 TCO（体积偏大） | TCO 注入最多 **8** 条 | 同左；误 abort 已修，但 grounded 仍易撞 **480s** 硬超时 |

## 本轮结论

1. Research 稳定：`parse=tool_trace`、8 sources、~2–3 min（相对 Before 的 13 min 空 pack）。
2. 误触 `signalEnoughEvidence` 已修：stderr 不再是 `budget exceeded after 0 searches`。
3. grounded 仍偶发 **480s timeout** → 总时长被 Workers 拉回 ~14–15 min；`15-29-18` 那次 51s 是 grounded 很快失败（误 abort），不是真跑通。

## 产物路径

- Before: `tmp/moa-c2-probe/2026-07-23T14-12-22-746Z/probe-report.json`
- After early-stop: `tmp/moa-c2-probe/2026-07-23T14-55-10-403Z/probe-report.json`
- After tool-trace: `tmp/moa-c2-probe/2026-07-23T15-29-18-737Z/probe-report.json`
- Rerun fix: `tmp/moa-c2-probe/2026-07-23T15-41-05-720Z/probe-report.json`
