/**
 * timer-task — DSH 代理可编排的定时任务插件(防呆自动关机备用方案)
 *
 * 模型工具:
 *   timer_schedule(name, command, delay_minutes, repeat) — 设置定时任务
 *   timer_cancel(name)                                    — 取消定时任务
 *   timer_veto(name)                                      — 阻止本次触发
 *
 * 触发流程:
 *   1. 到点 -> 向设置者会话注入提示(告知将执行的动作)
 *   2. 若设置者正在跑子代理(被阻塞), 提示注入到活跃子代理
 *   3. 等待 vetoWindowSeconds 窗口; 代理可在下次工具调用前调 timer_veto,
 *      或 (子代理无自定义工具时) 用 bash `touch <vetoDir>/<name>` 标记
 *   4. 无 veto -> 执行 command; 有 veto -> 跳过本次 (repeat 任务排下一周期)
 *
 * 任务持久化到 persistFile, 重启恢复。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

const name = "timer-task";
const inject = ["tools", "agents", "commands"];

// 默认数据目录: 用户家目录下的 DSH 插件目录 (可通过 cordis.patch.yml config 覆盖)
const DEFAULT_DATA_DIR = join(os.homedir(), ".dsh", "plugins", "dsh-timer-task");
const DEFAULTS = {
  vetoWindowSeconds: 60,
  checkIntervalSeconds: 20,
  vetoDir: join(DEFAULT_DATA_DIR, "veto"),
  persistFile: join(DEFAULT_DATA_DIR, "tasks.json"),
};

function apply(ctx, cfg) {
  const config = { ...DEFAULTS, ...(cfg ?? {}) };
  const vetoDir = config.vetoDir;
  mkdirSync(vetoDir, { recursive: true });

  /** @type {Map<string, {name:string, command:string, dueAt:number, repeat:boolean, intervalMin:number, sessionId:string, createdAt:number}>} */
  const tasks = new Map();
  /** 本次触发已 veto 的任务 */
  const vetoedThisFire = new Set();
  /** 正在触发中的任务(防重入) */
  const firing = new Set();

  // ---- 持久化 ----
  function persist() {
    try {
      writeFileSync(config.persistFile, JSON.stringify([...tasks.values()], null, 2), "utf8");
    } catch (err) {
      ctx.logger.warn(`timer-task: persist failed: ${err.message}`);
    }
  }
  function load() {
    try {
      if (!existsSync(config.persistFile)) return;
      const arr = JSON.parse(readFileSync(config.persistFile, "utf8"));
      for (const t of arr) tasks.set(t.name, t);
    } catch (err) {
      ctx.logger.warn(`timer-task: load failed: ${err.message}`);
    }
  }
  load();

  // ---- veto 标记文件 ----
  function scanVetoFiles() {
    let files = [];
    try { files = readdirSync(vetoDir); } catch { return; }
    for (const f of files) {
      if (tasks.has(f)) vetoedThisFire.add(f);
      try { unlinkSync(join(vetoDir, f)); } catch {}
    }
  }

  // 工作区 veto 标记: 各活跃 agent 的 cwd 下 .timer-veto-<name>
  // (子代理 bash 沙箱只能写自己的工作区, 故标记必须放工作区内)
  function scanWorkspaceVeto(targetCwds, taskName) {
    for (const cwd of targetCwds) {
      const f = join(cwd, `.timer-veto-${taskName}`);
      if (existsSync(f)) {
        vetoedThisFire.add(taskName);
        try { unlinkSync(f); } catch {}
      }
    }
  }

  // ---- 注入 ----
  function injectPrompt(agent, text) {
    const message = createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "plugin", plugin: name },
    });
    try {
      agent.inject(message);
      return true;
    } catch (err) {
      ctx.logger.warn(`timer-task: inject failed for agent ${agent.id}: ${err.message}`);
      try { agent.followup(message); return true; } catch (err2) {
        ctx.logger.warn(`timer-task: followup failed for agent ${agent.id}: ${err2.message}`);
        return false;
      }
    }
  }

  // ---- 触发 ----
  async function fire(task) {
    if (firing.has(task.name)) return;
    firing.add(task.name);
    vetoedThisFire.delete(task.name);
    try {
      const owner = ctx.agents.get(task.sessionId);
      // 注入目标: 设置者 + 所有 running agent(活跃子代理); 记录其工作区用于 veto 标记轮询
      const targets = [];
      if (owner && owner.status === "running") {
        for (const a of ctx.agents.list()) {
          if (a.status === "running" || a.id === owner.id) targets.push(a);
        }
      } else if (owner) {
        targets.push(owner);
      } else {
        // 设置者会话不存在(可能已删): 仍执行默认动作
        ctx.logger.warn(`timer-task: owner session ${task.sessionId} gone, executing anyway`);
      }
      const targetCwds = new Set();
      for (const a of targets) {
        const cwd = a?.session?.header?.cwd;
        if (cwd) targetCwds.add(cwd);
      }

      // 任务类型 → veto 后语义说明
      const taskKind = task.untilDone ? "until-done" : task.repeat ? "recurring" : "once";
      const purpose = task.description ? `(目的: ${task.description})` : "";
      let afterVeto;
      if (taskKind === "recurring") {
        afterVeto = `若阻止本次, 任务会在 ${task.intervalMin} 分钟后再次询问, 直到手动 timer_cancel。`;
      } else if (taskKind === "until-done") {
        afterVeto = `若阻止本次, 任务会在 ${task.intervalMin} 分钟后再次询问; 执行成功一次后任务自动结束, 无需手动取消。`;
      } else {
        afterVeto = "这是唯一一次触发: 若阻止本次, 任务即结束, 不再询问。";
      }

      // 区分受众的注入提示: 主代理有 timer_veto 工具, 子代理(toolFilter 白名单)只能用 bash 标记
      for (const a of targets) {
        const isSub = a.id !== task.sessionId;
        let text;
        if (isSub) {
          text = `[timer-task] 主代理设置了一个定时任务 '${task.name}' 即将触发${purpose}, 动作命令: ${task.command}。\n` +
            `- 若你还有未完成的工作, 或后续步骤依赖本会话继续: 请用 bash 在当前工作目录执行: touch .timer-veto-${task.name} 以阻止本次触发(若 timer_veto 工具在你的工具列表中, 也可直接调用它)。\n` +
            `- 若你的工作已全部完成: 无需任何操作, 任务将自动执行。\n` +
            `- ${afterVeto}\n` +
            `- 系统会等待所有活跃工作结束后再执行; 全部停止后 ${config.vetoWindowSeconds} 秒内无人 veto 则执行。`;
        } else {
          text = `[timer-task] 你设置的定时任务 '${task.name}' 即将触发${purpose}, 动作命令: ${task.command}。\n` +
            `- 若所有工作已完成、无需保护: 无需任何操作, 任务将在全部 agent 空闲后自动执行。\n` +
            `- 若有未完成的工作(包括进行中/计划中的子代理或后台任务): 调用 timer_veto 工具(name="${task.name}") 阻止本次触发。\n` +
            `- ${afterVeto}\n` +
            `- 若不再需要该任务: 调用 timer_cancel(name="${task.name}") 永久取消。\n` +
            `- 系统会等待所有活跃工作结束后再执行; 全部停止后 ${config.vetoWindowSeconds} 秒内无人 veto 则执行。`;
        }
        injectPrompt(a, text);
      }

      // veto 窗口(动态): 任何 agent 仍在 running(有活跃工作)就持续延长,
      // 全部 idle 后再走完固定宽限; 宽限内无人 veto 才执行 —— 防误杀长工具执行中的子代理
      const graceMs = config.vetoWindowSeconds * 1000;
      let deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        if (vetoedThisFire.has(task.name)) break;
        scanVetoFiles();
        scanWorkspaceVeto(targetCwds, task.name);
        if (vetoedThisFire.has(task.name)) break;
        const busy = ctx.agents.list().some((a) => a.status === "running");
        if (busy) deadline = Date.now() + graceMs; // 有活跃工作, 窗口延长
        await sleep(5000);
      }

      if (vetoedThisFire.has(task.name)) {
        ctx.logger.info(`timer-task: '${task.name}' VETOED this fire, skipped`);
        if (task.repeat || task.untilDone) {
          // recurring/until-done: veto 后重排, 下次周期再问
          task.dueAt = Date.now() + task.intervalMin * 60_000;
          persist();
        } else {
          // once: veto 即结束
          tasks.delete(task.name);
          persist();
        }
        return;
      }

      ctx.logger.info(`timer-task: '${task.name}' executing: ${task.command}`);
      await execCommand(task.command);

      // 执行成功后的任务归宿 + 通知设置者
      let doneNote;
      if (task.untilDone) {
        // 执行成功一次 → 收工
        tasks.delete(task.name);
        doneNote = `已执行完成, 任务 '${task.name}' 结束(until-done 收工)。`;
      } else if (task.repeat) {
        task.dueAt = Date.now() + task.intervalMin * 60_000;
        doneNote = `已执行完成, 将在 ${task.intervalMin} 分钟后再次触发。`;
      } else {
        tasks.delete(task.name);
        doneNote = "已执行完成, 任务结束。";
      }
      persist();
      const liveOwner = ctx.agents.get(task.sessionId);
      if (liveOwner) {
        injectPrompt(liveOwner, `[timer-task] 定时任务 '${task.name}' ${doneNote}`);
      }
    } finally {
      firing.delete(task.name);
    }
  }

  // ---- 主循环 ----
  setInterval(() => {
    const now = Date.now();
    for (const task of [...tasks.values()]) {
      if (now >= task.dueAt && !firing.has(task.name)) {
        fire(task).catch((err) => ctx.logger.warn(`timer-task: fire failed: ${err.message}`));
      }
    }
  }, config.checkIntervalSeconds * 1000);

  // ---- 工具 ----
  ctx.tools.register(defineTool({
    name: "timer_schedule",
    description:
      "Schedule a timer task that fires after delay_minutes and runs `command`. " +
      "When it fires, the owning session (or its blocking subagent) is prompted (with the task description) and may veto " +
      "this firing with timer_veto; if nobody vetoes, the command executes. " +
      "Three lifecycles: default 'once' = fires once, ends after firing or being vetoed. " +
      "'until-done' (untilDone=true, most useful) = if vetoed it re-asks every interval_minutes; after ONE successful execution the task ends by itself. " +
      "'recurring' (repeat=true) = re-schedules every interval_minutes after every firing (veto or execution) until timer_cancel. " +
      "Always provide a description so agents receiving the prompt know what the task is for. " +
      "Task names are globally unique across sessions: creating a name that already exists is rejected (cancel it first, or via /timer cancel). " +
      "Tasks are durable: they survive restarts.",
    parameters: {
      name: { type: "string", required: true, description: "Unique task name, e.g. 'auto-shutdown'." },
      command: { type: "string", required: true, description: "Shell command to run when the task fires unvetoed." },
      delay_minutes: { type: "number", required: true, description: "Minutes until first firing." },
      description: { type: "string", description: "What this task is for (shown to agents on every firing), e.g. 'shut down the cloud build instance after work finishes'." },
      untilDone: { type: "boolean", description: "If vetoed, re-ask every interval_minutes; ends after one successful execution (default false)." },
      repeat: { type: "boolean", description: "Re-schedule every interval_minutes after each firing until canceled (default false; mutually exclusive with untilDone)." },
      interval_minutes: { type: "number", description: "Interval for untilDone/repeat (required when either is true)." },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } },
      render: (_args, value) => [{ type: "text", text: value?.ok ? "timer scheduled" : "timer schedule failed" }],
    },
    execute(args, exec) {
      const taskName = String(args.name ?? "").trim();
      const command = String(args.command ?? "").trim();
      const delayMin = Number(args.delay_minutes ?? 0);
      const description = String(args.description ?? "").trim();
      if (!taskName || !command || !Number.isFinite(delayMin) || delayMin < 0) {
        throw new Error("timer_schedule: name/command/delay_minutes required, delay_minutes >= 0");
      }
      const untilDone = Boolean(args.untilDone);
      const repeat = Boolean(args.repeat);
      if (untilDone && repeat) {
        throw new Error("timer_schedule: untilDone and repeat are mutually exclusive");
      }
      const needsInterval = untilDone || repeat;
      const intervalMin = Number(args.interval_minutes ?? (needsInterval ? delayMin : 0));
      if (needsInterval && (!Number.isFinite(intervalMin) || intervalMin < 1)) {
        throw new Error("timer_schedule: interval_minutes required when untilDone/repeat is true");
      }
      const sessionId = exec.agent?.id ?? "unknown";
      const existing = tasks.get(taskName);
      if (existing) {
        // name 全局唯一: 同名创建拒绝, 防跨会话误覆盖
        throw new Error(
          `timer_schedule: task '${taskName}' already exists (owned by session ${String(existing.sessionId).slice(0, 12)}). ` +
          `Cancel it first (/timer cancel ${taskName}) or use another name.`
        );
      }
      tasks.set(taskName, {
        name: taskName,
        command,
        description,
        dueAt: Date.now() + delayMin * 60_000,
        untilDone,
        repeat,
        intervalMin: needsInterval ? intervalMin : 0,
        sessionId,
        createdAt: Date.now(),
      });
      persist();
      ctx.logger.info(`timer-task: scheduled '${taskName}' in ${delayMin}min (untilDone=${untilDone} repeat=${repeat}) by ${sessionId}`);
      return { ok: true };
    },
  }));

  ctx.tools.register(defineTool({
    name: "timer_cancel",
    description: "Cancel a previously scheduled timer task by name. The task will never fire again. Safe to call when the task does not exist.",
    parameters: {
      name: { type: "string", required: true, description: "Task name to cancel." },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } },
      render: (_args, value) => [{ type: "text", text: value?.ok ? "timer canceled" : "timer not found" }],
    },
    execute(args, exec) {
      const taskName = String(args.name ?? "").trim();
      const removed = tasks.delete(taskName);
      vetoedThisFire.delete(taskName);
      persist();
      ctx.logger.info(`timer-task: canceled '${taskName}' (${removed ? "was active" : "not found"})`);
      return { ok: removed };
    },
  }));

  ctx.tools.register(defineTool({
    name: "timer_veto",
    description:
      "Veto the next firing of a timer task by name. Call this BEFORE your next tool call when a scheduled task " +
      "is about to fire but you still have unfinished work, or work depends on this session continuing " +
      "(e.g. a long build in progress, pending subagents, or a later phase that must run first). " +
      "If all work is done, do nothing and let the task execute. Only affects the current firing; recurring tasks re-schedule.",
    parameters: {
      name: { type: "string", required: true, description: "Task name to veto." },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } },
      render: (_args, value) => [{ type: "text", text: value?.ok ? "veto recorded" : "veto failed" }],
    },
    execute(args, exec) {
      const taskName = String(args.name ?? "").trim();
      if (!tasks.has(taskName)) return { ok: false };
      vetoedThisFire.add(taskName);
      ctx.logger.info(`timer-task: VETO recorded for '${taskName}'`);
      return { ok: true };
    },
  }));

  // ---- 用户斜杠命令: /timer [list|all|cancel <name>] ----
  // 默认 list 只显示当前会话的任务; /timer all 显示所有会话
  function renderTasks(scope, sessionId) {
    const all = scope === "all";
    const list = [...tasks.values()]
      .filter((t) => all || t.sessionId === sessionId)
      .sort((a, b) => a.dueAt - b.dueAt);
    if (list.length === 0) {
      return all
        ? "No scheduled timer tasks."
        : "No timer tasks in this session. Use /timer all to see every session's tasks.";
    }
    const lines = list.map((t) => {
      const kind = t.untilDone ? "until-done" : t.repeat ? "recurring" : "once";
      const mins = Math.max(0, Math.round((t.dueAt - Date.now()) / 60000));
      const desc = t.description ? ` (${t.description})` : "";
      const owner = all ? ` [session ${String(t.sessionId).slice(0, 12)}]` : "";
      return `- ${t.name}${owner} [${kind}] fires in ~${mins}min${desc}\n  command: ${t.command}`;
    });
    const tip = all
      ? "Use /timer cancel <name> to remove one."
      : "Use /timer all to see every session's tasks. /timer cancel <name> removes one.";
    return `Scheduled timer tasks:\n${lines.join("\n")}\n\n${tip}`;
  }
  ctx.commands.register({
    name: "timer",
    description: "list (this session) / all (every session) / cancel scheduled timer tasks",
    input: { hint: "[list|all|cancel <name>]" },
    handler: (invocation) => {
      const line = String(invocation?.rawInput ?? "").trim();
      const sessionId = invocation?.agent?.id;
      try {
        if (line === "" || line === "list") {
          return { kind: "success", text: renderTasks("session", sessionId) };
        }
        if (line === "all") {
          return { kind: "success", text: renderTasks("all") };
        }
        const [action, ...rest] = line.split(/\s+/);
        if (action === "cancel") {
          const taskName = rest.join(" ");
          if (!taskName) {
            return { kind: "error", text: "Usage: /timer cancel <name>\n" + renderTasks("all") };
          }
          if (!tasks.has(taskName)) {
            return { kind: "error", text: `No task named '${taskName}'. Run /timer all to list tasks.` };
          }
          tasks.delete(taskName);
          vetoedThisFire.delete(taskName);
          persist();
          ctx.logger.info(`timer-task: canceled '${taskName}' via /timer command`);
          return { kind: "success", text: `Timer task '${taskName}' canceled.` };
        }
        return { kind: "error", text: `Unknown /timer action '${action}'. Usage: /timer [list|all|cancel <name>]` };
      } catch (err) {
        return { kind: "error", text: `timer command failed: ${err.message}` };
      }
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execCommand(command) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => {
      console.log(`[timer-task] exec exit=${code}:\n${out.slice(0, 1500)}`);
      resolve();
    });
  });
}

export { name, inject, apply };
export default { name, inject, apply };
