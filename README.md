# dsh-deadman

[English](README.en.md) | 中文

DeepSeek Harness（dsh）的**死手开关**（deadman switch）：布防后定期巡检"还有人活着干活吗"，没人报活就执行你指定的命令。

适合无人值守的长任务——夜间编译、训练、批量渲染、云实例跑批。常规"到点无条件关机"会误杀还在跑的工作；死手开关反过来问一句：**还有人在推进吗？没有就把资源收掉。**

## 与 dsh 内置「自动化任务」的区别

| | dsh 内置 `dsh-schedule` | dsh-deadman |
|---|---|---|
| 到点做什么 | 把一条消息投回会话收件箱，**由模型决定干什么** | **直接执行 shell 命令**，不经模型 |
| 阻止机制 | 无 | **报活闸门**：有 agent 在推进就自动顺延，无人报活才执行 |
| 典型场景 | 日程提醒、叫醒会话 | 无人值守止损：活儿干完/挂掉了，自动关机 |

两者互补，不冲突。内置那套的前提是"模型还活着能处理消息"；资源该被收回的时刻，往往正是模型已经挂掉或额度耗尽的时刻。

## 安装

要求 dsh **0.2.0-rc.2**（`peerDependencies` 精确对齐；版本不匹配时 dsh 会拒绝安装并给出提示）。

```sh
# 本地路径
dsh plugin --profile web add /path/to/dsh-deadman

# 或从 GitHub
dsh plugin --profile web add github:OWNER/dsh-deadman
```

Web / 桌面端：在插件页启用 **dsh-deadman**。CLI：`dsh plugin --profile <name> remove dsh-deadman` 卸载。

> 装在**长期运行**的 profile（如 `web`）里才有意义，原因见[已知限制](#已知限制)。
> 依赖一律精确锁定 0.2.0-rc.2：从 GitHub 安装时 pnpm 会按 `dependencies` 自动装好；用**本地路径**安装时 pnpm 走 `link:`，不会解析依赖，所以插件目录里必须先有 `node_modules`（在插件目录执行一次 `pnpm install`）。

## 模型工具

| 工具 | 作用 |
|---|---|
| `deadman_arm` | 布防：`name` / `command` / `after_minutes` / `interval_minutes` / `description`。首次巡检在 `after_minutes` 后；被报活则 `interval_minutes` 后重新巡检；**执行成功一次即收工**，无需事后取消 |
| `deadman_hold` | 报活："我还在干活"，跳过本轮，按周期重排。**任何会话都能报活**（fail-safe 语义） |
| `deadman_disarm` | 撤防。仅布防会话（或其直接子代理）可用；其他会话需显式 `force=true`，且会被记入日志 |

任务名在进程内**全局唯一**；同名布防会被拒绝，并告诉你被哪个会话占着。

斜杠命令：`/deadman`（本会话）· `/deadman all`（全部会话）· `/deadman cancel <name>`。

## 一次触发的判定顺序

1. **解析属主会话**：先 `ctx.agents.get()`；会话没打开就 `ctx.agents.resume()` 把它**恢复出来**再投递（只要会话还存在，提示就不会掉进黑洞）。
2. **投递巡检询问**：用 `agent.send(message, "next-step", true)` —— 运行中的 agent 在下个步骤边界看到，空闲的会被唤醒。询问文案里明确要求对方**不要向用户提问、不要请求确认**，只能二选一：报活或保持沉默。
3. **巡检循环**，判据是**活跃度**而不是状态：
   - 任一 agent 自上次巡检有新事件（`session.seq` 推进）⇒ 还在推进，继续等；
   - 全部无推进 ⇒ 开始计宽限 `holdWindowSeconds`；
   - 有"待用户回答的提问"（`userQuestions` 投影里 `state === 'open'`）⇒ 单独计时，最长 `questionBlockSeconds` 后放行；
   - 从触发那一刻起的总上限 `maxHoldMinutes`，到顶一律放行（fail-open）。
4. **放行** ⇒ 执行命令；成功后**任务自动收工**并给属主留一条通知；被报活 ⇒ 重排下一周期。

## 报活通道

1. `deadman_hold` 工具（主代理、或被授予该工具的子代理）；
2. 在当前工作目录建标记文件 `.deadman-hold-<name>`（子代理工具白名单里没有 `deadman_hold` 时可用）；
3. 在插件数据目录 `hold/` 下建以任务名命名的文件（外部脚本、人工介入）。

## 多会话行为

- 每个任务记着自己的**属主会话**，只向属主投递巡检询问；属主正在运行时，也会顺带通知其它正在运行的 agent（现场执行者）。
- 活跃度判据默认是**全局**的（`progressScope: global`）：只要整机还有活在推进，所有看门狗都往后顺延——对"自动关机"这是正确语义。想让某个看门狗只看自己那一伙，设 `progressScope: owner`。
- 多个看门狗同时到期会**并发执行**各自的命令（无全局锁）；需要串行就打开 `serializeCommands`。
- 报活无权限限制（谁都能喊停），**撤防有权限限制**（见 `deadman_disarm`）。

## 配置

写在 profile 的 `cordis.patch.yml` 里覆盖 bundle 默认值：

```yaml
- id: deadman
  config:
    holdWindowSeconds: 60
```

| 键 | 默认 | 说明 |
|---|---|---|
| `holdWindowSeconds` | `60` | 全部 agent 无推进后，再等多久执行 |
| `checkIntervalSeconds` | `20` | 巡检周期 |
| `maxHoldMinutes` | `30` | 从触发起的总上限，到顶一律放行 |
| `questionBlockSeconds` | `600` | 被"待回答的提问"卡住时的最长等待，到点放行 |
| `onUndeliverable` | `execute` | 属主会话彻底投递不到时：`execute` 照常执行 / `skip` 放弃本轮 |
| `progressScope` | `global` | 活跃度判据范围：`global` 整机 / `owner` 仅属主及其直接子代理 |
| `serializeCommands` | `false` | 多条动作命令是否排队串行执行 |
| `commandTimeoutSeconds` | `300` | 单条动作命令的执行超时 |
| `dataDir` | `$DSH_HOME/plugins/dsh-deadman` | 数据目录（`tasks.json` + `hold/`） |

## 数据与持久化

- `tasks.json`：任务表，插件启动时载入，**重启不丢**（逾期的一次性任务会在下次巡检立刻处理）。
- `hold/`：外部报活标记目录。
- 字段：`name` / `command` / `description` / `dueAt` / `intervalMin` / `sessionId` / `createdAt` / `firedCount`。

## 已知限制

- **只在长期运行的实例里有效**：调度器活在 dsh 进程内。在 headless 一次性进程里布防，进程退出后没人巡检（除非之后有长驻实例启动时把它载入）。
- **单写者假设**：`tasks.json` 是普通 JSON 文件，多进程同时写会互相覆盖。不要在多进程里同时布防；本插件按"只装长期运行 profile"设计。
- `progressScope: owner` 只统计属主与它的**直接**子代理，更深层的孙代理不计入。
- 提问阻塞闸门依赖会话投影 `userQuestions`；宿主没有该投影时该闸门不生效（只会走其它闸门，不会误判）。
- 不保证"恰好执行一次"：宿主崩溃可能留下已执行但未记账的任务。
- 三条闸门（`progressScope` 两种取值的差别、提问阻塞放行、`maxHoldMinutes` 到顶放行）已由 `npm test` 的假宿主测试套件覆盖（`tests/fake-host.mjs`，确定性复现）；**未覆盖**的是"真实会话里等满 600 秒提问超时"这一长等待过程，以及多进程布防。

## 安全

- 执行的命令**完全由布防方指定**：只调度你信任的命令。
- 默认语义是 **fail-open**（无人报活即执行）——这正是死手开关的本意，但请为关键动作设定合理的巡检周期与宽限。
- 插件不联网、不收集数据；数据只写在本机数据目录。

## 开发

```sh
pnpm install            # 依赖已随仓库锁定在 0.2.0-rc.2
node --check lib/index.js
```

改动代码后**必须重启 dsh 进程**才生效（ESM 模块在启动时载入，热更新只覆盖 profile 配置层）。

## 许可

MIT
