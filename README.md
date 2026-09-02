# dsh-timer-task

DeepSeek Harness (dsh) 定时任务插件：让代理自己编排"到点执行某命令"的重复任务，触发前会询问代理是否阻止（veto），代理无法响应时才真正执行。

A DeepSeek Harness (dsh) plugin that lets the agent schedule recurring timer tasks ("run this command when due"). Before a firing executes, the owning session (or its blocking subagent) is prompted and may veto it; only when nobody vetoes does the action run.

## 功能特性 / Features

- 三个模型可调用工具 / Three model-facing tools:
  - `timer_schedule` — 设置定时任务（一次性或重复型）
  - `timer_cancel` — 取消任务
  - `timer_veto` — 阻止本次触发
- 触发前注入询问（主代理或活跃子代理），子代理可用 bash 标记文件 veto
- 动态 veto 窗口：只要有 agent 仍在运行（工作未完成）就自动延长，全部空闲后再走固定宽限
- 任务持久化到磁盘，dsh 重启不丢

## 典型场景 / Typical use case

夜间无人值守跑长任务（如编译）时，让代理设置一个"每 30 分钟自动关机"的定时任务：

```text
timer_schedule(name="auto-shutdown",
  command="bash /path/to/your/stop-instances.sh",
  delay_minutes=30, repeat=true)
```

- 任务还在跑（子代理活跃）→ 触发时子代理收到注入，判断"工作未完成"→ veto → 跳过本次
- 全部工作完成 / 代理停摆（如 API 余额耗尽）→ 无人 veto → 自动执行关机 → 止损

## 安装 / Install

```bash
# 从 GitHub 安装
dsh plugin --profile <name> add github:YOUR_NAME/dsh-timer-task

# 或本地路径
dsh plugin --profile <name> add /path/to/dsh-timer-task
```

在 profile 的 `cordis.patch.yml`（或插件自带 patch）中启用 `timer-task` 条目后重启 dsh。

## 配置 / Configuration

| 配置项 | 默认 | 说明 |
|---|---|---|
| `vetoWindowSeconds` | 60 | 全部 agent 空闲后，无人 veto 的宽限窗口（秒） |
| `checkIntervalSeconds` | 20 | 定时器检查周期（秒） |
| `vetoDir` | `~/.dsh/plugins/dsh-timer-task/veto` | 全局 veto 标记目录（插件进程可写） |
| `persistFile` | `~/.dsh/plugins/dsh-timer-task/tasks.json` | 任务持久化文件 |

## 工作原理 / How it works

1. 到点触发 → 向设置任务的会话注入提示（`agent.inject()`，通知型，不打断工作流）
2. 若设置者正在跑子代理 → 提示注入到活跃子代理
3. 等待 veto 窗口：任何 agent 仍在 running 就持续延长；全部 idle 后走完 `vetoWindowSeconds`
4. 窗口内无人 veto → 执行 `command`；有人 veto → 跳过本次（重复型任务重排下一周期）

veto 通道（任一即可）：
- `timer_veto` 工具（主代理/有该工具的代理）
- bash 在工作区创建标记文件 `.timer-veto-<name>`（子代理 toolFilter 白名单场景）
- 全局 `vetoDir` 下创建 `<name>` 文件（外部手动）

任务数据含会话归属，默认存于用户家目录（`os.homedir()` 解析，可通过配置覆盖）；动作命令由使用方自行指定，插件本身不内置任何外部调用。

## 安全说明 / Security notes

- 插件执行的命令完全由 `timer_schedule` 的调用方（代理/用户）指定——请只调度你信任的命令
- 默认语义是"无人 veto 则执行"（fail-open 倾向），请为关键动作设置合理的重复周期与宽限
- 数据文件仅本用户可写；发布版本不含任何个人配置或凭据

## License

MIT
