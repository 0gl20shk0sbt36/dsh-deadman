/**
 * dsh-deadman — DSH 看门狗（deadman switch）
 *
 * 语义: 布防后, 到点巡检一次"是否还有活着的工作"; 有人报活(hold)就跳过并按周期重排,
 * 没人报活就执行你指定的命令。执行成功即收工 —— 没有人需要去取消它。
 *
 * 模型工具:
 *   deadman_arm(name, command, after_minutes, interval_minutes, description) — 布防
 *   deadman_hold(name)   — 报活("我还在干活"), 本次跳过, 按周期重排
 *   deadman_disarm(name) — 撤防(彻底取消)
 *
 * 一次触发的判定顺序:
 *   1. 解析属主会话: ctx.agents.get() 拿不到就 ctx.agents.resume() 把会话恢复出来
 *      (0.1.x 时代只 get(), 会话没打开时提示会掉进黑洞 —— 这是本版修掉的第一个问题)
 *   2. 投递询问: 用 agent.followup() 唤醒型投递(inject 不唤醒, idle 会话永远看不到)
 *   3. 循环巡检, 判据是"活跃度"而不是 status:
 *        - 任一 agent 自上次巡检有新事件(session.seq 推进) ⇒ 还在推进, 继续等
 *        - 全部无推进 ⇒ 开始计宽限 holdWindowSeconds
 *        - 有"待用户回答的提问"(userQuestions 投影 state==='open') ⇒ 单独计时,
 *          最长 questionBlockSeconds 后放行
 *        - 从触发起的总上限 maxHoldMinutes, 到顶一律放行(fail-open)
 *   4. 放行 ⇒ 执行命令; 成功 ⇒ 任务收工并通知属主; 被 hold ⇒ 重排下一周期
 *
 * 任务持久化到 tasks.json, 重启恢复。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const name = "deadman";
/** 需要框架先就绪的服务: 工具注册表、agent 注册表、斜杠命令。 */
const inject = ["tools", "agents", "commands"];

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
  ? process.env.DSH_HOME
  : join(os.homedir(), ".dsh");
const DEFAULT_DATA_DIR = join(DSH_HOME, "plugins", "dsh-deadman");

const DEFAULTS = {
  /** 全部 agent 无推进后, 再等多久执行(秒)。 */
  holdWindowSeconds: 60,
  /** 巡检周期(秒)。 */
  checkIntervalSeconds: 20,
  /** 从触发起算的总上限(分钟), 到顶一律放行。 */
  maxHoldMinutes: 30,
  /** 被"待回答的提问"卡住时的最长等待(秒)。 */
  questionBlockSeconds: 600,
  /** 属主会话彻底投递不到时: execute | skip。 */
  onUndeliverable: "execute",
  /** 活跃度判据范围: global(整机安静才执行) | owner(只看属主会话及其直接子代理)。 */
  progressScope: "global",
  /** 多条动作命令是否排队串行执行(默认并发)。 */
  serializeCommands: false,
  /** 单条动作命令的执行超时(秒)。 */
  commandTimeoutSeconds: 300,
  /** 数据目录。 */
  dataDir: DEFAULT_DATA_DIR,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (id) => String(id ?? "").slice(0, 12);

/** 从属主会话里拿 cwd, 用于子代理的工作区 hold 标记。 */
function cwdOf(agent) {
  try {
    return agent?.session?.header?.cwd ?? undefined;
  } catch {
    return undefined;
  }
}

function apply(ctx, cfg) {
  const config = { ...DEFAULTS, ...(cfg ?? {}) };
  const dataDir = config.dataDir;
  const holdDir = join(dataDir, "hold");
  const persistFile = join(dataDir, "tasks.json");
  mkdirSync(holdDir, { recursive: true });

  /** @type {Map<string, {name:string, command:string, description:string, dueAt:number, intervalMin:number, sessionId:string, createdAt:number, firedCount:number}>} */
  const tasks = new Map();
  /** 本次触发已被报活(hold)的任务。 */
  const heldThisFire = new Set();
  /** 正在触发中的任务(防重入)。 */
  const firing = new Set();

  // ---------- 持久化 ----------
  function persist() {
    try {
      writeFileSync(persistFile, JSON.stringify([...tasks.values()], null, 2), "utf8");
    } catch (err) {
      ctx.logger.warn(`deadman: persist failed: ${err.message}`);
    }
  }

  function load() {
    try {
      if (!existsSync(persistFile)) return;
      const rows = JSON.parse(readFileSync(persistFile, "utf8"));
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (row && typeof row.name === "string") tasks.set(row.name, row);
      }
      ctx.logger.info(`deadman: restored ${tasks.size} task(s) from ${persistFile}`);
    } catch (err) {
      ctx.logger.warn(`deadman: load failed: ${err.message}`);
    }
  }
  load();

  // ---------- 会话解析(修 bug ①: 会话没打开也要投递得到) ----------
  async function resolveOwner(sessionId) {
    const live = ctx.agents.get(sessionId);
    if (live) return live;
    try {
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId });
      const agent = handle?.agent ?? ctx.agents.get(sessionId) ?? null;
      if (agent) ctx.logger.info(`deadman: resumed session ${short(sessionId)} to deliver`);
      return agent;
    } catch (err) {
      ctx.logger.warn(`deadman: cannot resume session ${short(sessionId)}: ${err.message}`);
      return null;
    }
  }

  // ---------- 投递 ----------
  function buildMessage(text, summary) {
    return createUserMessage({
      content: [{ type: "text", text }],
      // 0.2.0 没有通用 plugin 来源: 每个插件声明自己的 kind; notice 需带一行 summary。
      source: { kind: "deadman", form: "notice", summary },
    });
  }

  /**
   * 投递一条消息。
   * @param wake true 用 send(next-step, wakeup) —— 下个步骤边界递给运行中的 agent, idle 时唤醒它;
   *             false 用 inject —— 只作下一步上下文, 不打扰(idle 会话可能一直看不到)
   */
  function deliver(agent, text, summary, wake) {
    const message = buildMessage(text, summary);
    try {
      if (wake) agent.send(message, "next-step", true);
      else agent.inject(message);
      return true;
    } catch (err) {
      ctx.logger.warn(`deadman: deliver failed for agent ${short(agent?.id)}: ${err.message}`);
      return false;
    }
  }

  // ---------- 活跃度判据 ----------
  function snapshot(scopeIds) {
    const map = new Map();
    for (const agent of ctx.agents.list()) {
      if (scopeIds && !scopeIds.has(agent.id)) continue;
      map.set(agent.id, Number(agent.session?.seq ?? 0));
    }
    return map;
  }

  /** owner 模式下的"自家人": 属主本身 + 它的直接子代理(更深层不计, 记在 README)。 */
  function crewIds(owner) {
    const ids = new Set();
    if (!owner) return ids;
    ids.add(owner.id);
    const liveOwner = ctx.agents.get(owner.id);
    if (liveOwner) {
      for (const agent of ctx.agents.list()) {
        if (agent.id !== liveOwner.id && ctx.agents.isOwnedBy(agent.id, liveOwner)) ids.add(agent.id);
      }
    }
    return ids;
  }

  /** 撤防权限: 属主本人, 或属主的直接子代理; 其它会话必须显式 force。 */
  function canManage(caller, task) {
    if (!caller) return false;
    if (caller.id === task.sessionId) return true;
    const owner = ctx.agents.get(task.sessionId);
    return Boolean(owner) && ctx.agents.isOwnedBy(caller.id, owner);
  }

  /** 与上次快照相比是否有推进(新事件 / 新 agent)。 */
  function progressed(prev, next) {
    for (const [id, seq] of next) {
      const before = prev.get(id);
      if (before === undefined || seq > before) return true;
    }
    return false;
  }

  /** 该 agent 当前是否有"待用户回答"的提问(state === 'open')。 */
  function hasOpenQuestion(agent) {
    try {
      const projections = ctx.get("sessionProjections");
      const state = projections?.stateOf?.(agent.session, "userQuestions");
      const active = state?.questions?.active ?? [];
      return active.some((question) => question?.state === "open");
    } catch {
      return false;
    }
  }

  // ---------- hold 通道 ----------
  function scanHoldDir(taskName) {
    let files = [];
    try {
      files = readdirSync(holdDir);
    } catch {
      return;
    }
    for (const file of files) {
      if (file !== taskName) continue;
      heldThisFire.add(taskName);
      try {
        unlinkSync(join(holdDir, file));
      } catch {
        /* 标记文件清理失败不算致命 */
      }
    }
  }

  function scanWorkspaceHold(cwds, taskName) {
    for (const cwd of cwds) {
      const marker = join(cwd, `.deadman-hold-${taskName}`);
      if (!existsSync(marker)) continue;
      heldThisFire.add(taskName);
      try {
        unlinkSync(marker);
      } catch {
        /* 同上 */
      }
    }
  }

  // ---------- 执行动作命令 ----------
  function execCommand(command) {
    return new Promise((resolve) => {
      const timeoutMs = Math.max(1, config.commandTimeoutSeconds) * 1000;
      const child = spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("close", (code, signal) => {
        ctx.logger.info(`deadman: exec exit=${code}${signal ? ` signal=${signal}` : ""}\n${output.slice(0, 1500)}`);
        resolve({ code, output });
      });
      child.on("error", (err) => {
        ctx.logger.warn(`deadman: exec failed: ${err.message}`);
        resolve({ code: null, output: err.message });
      });
    });
  }

  /** 可选串行: serializeCommands 打开时, 同一进程内的多条动作命令排队执行。 */
  let commandQueue = Promise.resolve();
  function runCommand(command) {
    if (!config.serializeCommands) return execCommand(command);
    const queued = commandQueue.then(() => execCommand(command), () => execCommand(command));
    commandQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  // ---------- 一次触发 ----------
  async function fire(task) {
    if (firing.has(task.name)) return;
    firing.add(task.name);
    heldThisFire.delete(task.name);
    try {
      const owner = await resolveOwner(task.sessionId);
      const targets = [];
      if (owner) {
        targets.push(owner);
        // 属主被阻塞(等子代理)时, 现场执行者也要问
        if (owner.status === "running") {
          for (const agent of ctx.agents.list()) {
            if (agent.id !== owner.id && agent.status === "running") targets.push(agent);
          }
        }
      }

      const purpose = task.description ? `（目的: ${task.description}）` : "";
      const interval = task.intervalMin;
      const afterHold = `报活后本次跳过, ${interval} 分钟后重新巡检。`;

      let delivered = false;
      for (const agent of targets) {
        const isSubagent = agent.id !== task.sessionId;
        const text = isSubagent
          ? `[deadman] 主代理布防的看门狗 '${task.name}' 正在巡检${purpose}, 若无人报活将执行: ${task.command}\n` +
            `- 不要向用户提问、不要请求确认、不要回复本条消息; 只做下面二选一。\n` +
            `- 你还有未完成的工作 ⇒ 在当前工作目录执行: touch .deadman-hold-${task.name} 报活。${afterHold}\n` +
            `- 你的工作已全部完成 ⇒ 什么都不做, 看门狗会在所有 agent 停止推进 ${config.holdWindowSeconds} 秒后执行。\n` +
            `- 判据是"有没有推进"而非"状态是否 running"; 卡在等用户回答不算推进。`
          : `[deadman] 你布防的看门狗 '${task.name}' 正在巡检${purpose}, 若无人报活将执行: ${task.command}\n` +
            `- 不要向用户提问、不要请求确认、不要回复本条消息; 只做下面二选一。\n` +
            `- 还有未完成的工作(含进行中的子代理、后台任务、依赖本会话继续的后续步骤) ⇒ 调用 deadman_hold(name="${task.name}") 报活。${afterHold}\n` +
            `- 工作已全部完成, 或本会话已停摆 ⇒ 什么都不做, 看门狗会在所有 agent 停止推进 ${config.holdWindowSeconds} 秒后执行。\n` +
            `- 判据是"有没有推进"而非"状态是否 running"; 卡在等用户回答不算推进 —— 最多等 ${config.questionBlockSeconds} 秒就会执行。\n` +
            `- 不再需要该看门狗 ⇒ 调用 deadman_disarm(name="${task.name}")。`;
        if (deliver(agent, text, `deadman ${task.name}`, true)) delivered = true;
      }

      if (!owner || !delivered) {
        ctx.logger.warn(`deadman: '${task.name}' could not be announced (owner=${owner ? "live" : "unreachable"})`);
        if (config.onUndeliverable === "skip") {
          task.dueAt = Date.now() + interval * 60_000;
          persist();
          return;
        }
      }

      const cwds = new Set();
      for (const agent of targets) {
        const cwd = cwdOf(agent);
        if (cwd) cwds.add(cwd);
      }

      // ---------- 巡检循环 ----------
      const startedAt = Date.now();
      const maxHoldUntil = startedAt + Math.max(1, config.maxHoldMinutes) * 60_000;
      const questionLimitMs = Math.max(0, config.questionBlockSeconds) * 1000;
      const scopeIds = config.progressScope === "owner" ? crewIds(owner) : undefined;
      let previous = snapshot(scopeIds);
      let idleSince = null;
      let questionSince = null;

      for (;;) {
        if (heldThisFire.has(task.name)) break;
        scanHoldDir(task.name);
        scanWorkspaceHold(cwds, task.name);
        if (heldThisFire.has(task.name)) break;

        if (Date.now() >= maxHoldUntil) {
          ctx.logger.warn(`deadman: '${task.name}' hit maxHoldMinutes (${config.maxHoldMinutes}min) -> executing`);
          break;
        }

        const current = snapshot(scopeIds);
        const advancing = progressed(previous, current);
        previous = current;

        if (advancing) idleSince = null;
        else if (idleSince === null) idleSince = Date.now();

        const questionBlocked = ctx.agents
          .list()
          .filter((agent) => !scopeIds || scopeIds.has(agent.id))
          .some((agent) => hasOpenQuestion(agent));
        if (questionBlocked) {
          if (questionSince === null) {
            questionSince = Date.now();
            ctx.logger.info(`deadman: '${task.name}' blocked by a pending user question`);
          } else if (Date.now() - questionSince >= questionLimitMs) {
            ctx.logger.warn(`deadman: '${task.name}' question-blocked for ${config.questionBlockSeconds}s -> executing`);
            break;
          }
        } else {
          questionSince = null;
        }

        const idleFor = idleSince === null ? 0 : Date.now() - idleSince;
        if (idleSince !== null && idleFor >= Math.max(0, config.holdWindowSeconds) * 1000) {
          ctx.logger.info(`deadman: '${task.name}' no progress for ${config.holdWindowSeconds}s -> executing`);
          break;
        }

        await sleep(Math.max(1, config.checkIntervalSeconds) * 1000);
      }

      // ---------- 归宿 ----------
      if (heldThisFire.has(task.name)) {
        ctx.logger.info(`deadman: '${task.name}' held off this round, re-arming in ${interval}min`);
        task.dueAt = Date.now() + interval * 60_000;
        persist();
        return;
      }

      task.firedCount = Number(task.firedCount ?? 0) + 1;
      ctx.logger.info(`deadman: '${task.name}' executing (firing #${task.firedCount}): ${task.command}`);
      const result = await runCommand(task.command);

      const outcome = result.code === 0 ? "执行成功" : `执行结束(exit=${result.code})`;
      const tail = result.output ? `\n输出尾部: ${result.output.slice(-400).trim()}` : "";
      const liveOwner = ctx.agents.get(task.sessionId);
      if (liveOwner) {
        deliver(liveOwner, `[deadman] 看门狗 '${task.name}' ${outcome}，任务已收工(命令: ${task.command})${tail}`, `deadman ${task.name} done`, false);
      }

      // 唯一生命周期: 执行过即收工。还需要就重新布防。
      tasks.delete(task.name);
      persist();
    } finally {
      firing.delete(task.name);
    }
  }

  // ---------- 调度 ----------
  ctx.effect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const task of [...tasks.values()]) {
        if (now >= task.dueAt && !firing.has(task.name)) {
          fire(task).catch((err) => ctx.logger.warn(`deadman: fire failed: ${err.message}`));
        }
      }
    }, Math.max(1, config.checkIntervalSeconds) * 1000);
    return () => clearInterval(timer);
  }, "deadman scheduler");

  // ---------- 工具 ----------
  ctx.tools.register(defineTool({
    name: "deadman_arm",
    description:
      "Arm a deadman switch: after `after_minutes` the watchdog checks whether work is still advancing, and runs `command` " +
      "when nobody holds it off. Use it to stop an unattended resource by itself when work finishes or you die " +
      "(e.g. shut a build instance down). " +
      "On every firing the owning session is asked and may hold (deadman_hold) to skip that round; a held round re-arms " +
      "`interval_minutes` later. ONE successful execution ends the task, so nobody has to cancel it afterwards. " +
      "The decision is based on whether the harness is still making progress, not on its status: a session stuck waiting " +
      "for a user answer does not count as progress and the command runs after at most questionBlockSeconds. " +
      "Always pass a description so the holder knows what the switch is for. Tasks are durable across restarts and names " +
      "are globally unique (arming an existing name is rejected).",
    parameters: {
      name: { type: "string", required: true, description: "Unique task name, e.g. 'auto-shutdown'." },
      command: { type: "string", required: true, description: "Shell command run when the switch fires unheld." },
      after_minutes: { type: "number", required: true, description: "Minutes until the first inspection." },
      interval_minutes: { type: "number", required: true, description: "Minutes between inspections after a held round." },
      description: { type: "string", description: "What this switch protects, e.g. 'shut the build instance down after the build finishes'. Shown on every inspection." },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: value?.ok ? "deadman armed" : "deadman arm failed" }],
    },
    execute(args, exec) {
      const taskName = String(args?.name ?? "").trim();
      const command = String(args?.command ?? "").trim();
      const afterMin = Number(args?.after_minutes ?? NaN);
      const intervalMin = Number(args?.interval_minutes ?? NaN);
      const description = String(args?.description ?? "").trim();
      if (!taskName || !command || !Number.isFinite(afterMin) || afterMin < 0) {
        throw new Error("deadman_arm: name/command/after_minutes are required (after_minutes >= 0)");
      }
      if (!Number.isFinite(intervalMin) || intervalMin < 1) {
        throw new Error("deadman_arm: interval_minutes must be a number >= 1");
      }
      if (tasks.has(taskName)) {
        const owner = short(tasks.get(taskName)?.sessionId);
        throw new Error(
          `deadman_arm: '${taskName}' already exists (armed by session ${owner}). Disarm it first (/deadman cancel ${taskName}) or pick another name.`
        );
      }
      const sessionId = exec?.agent?.id ?? "unknown";
      tasks.set(taskName, {
        name: taskName,
        command,
        description,
        dueAt: Date.now() + afterMin * 60_000,
        intervalMin,
        sessionId,
        createdAt: Date.now(),
        firedCount: 0,
      });
      persist();
      ctx.logger.info(`deadman: armed '${taskName}' (after ${afterMin}min, retry ${intervalMin}min) by ${sessionId}`);
      return { ok: true };
    },
  }));

  ctx.tools.register(defineTool({
    name: "deadman_hold",
    description:
      "Hold a deadman switch off for the current round: call it when the switch is being inspected but you still have " +
      "unfinished work (a running build, pending subagents, or a later step that needs this session). The round is " +
      "skipped and the next inspection happens after interval_minutes. If all work is done, do nothing. " +
      "Only affects the current round; it is not a cancel.",
    parameters: {
      name: { type: "string", required: true, description: "Task name to hold off." },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: value?.ok ? "hold recorded" : "hold failed: no such task" }],
    },
    execute(args) {
      const taskName = String(args?.name ?? "").trim();
      if (!tasks.has(taskName)) return { ok: false };
      heldThisFire.add(taskName);
      ctx.logger.info(`deadman: hold recorded for '${taskName}'`);
      return { ok: true };
    },
  }));

  ctx.tools.register(defineTool({
    name: "deadman_disarm",
    description:
      "Disarm a deadman switch by name so it never fires again. Safe when the task does not exist. " +
      "Only the session that armed it (or one of its direct subagents) may disarm it: another session is refused " +
      "unless it passes force=true, which is logged. Holding a switch off is unrestricted; disarming someone else's " +
      "is not.",
    parameters: {
      name: { type: "string", required: true, description: "Task name to disarm." },
      force: { type: "boolean", description: "Disarm a switch armed by another session (logged as a warning)." },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          reason: { type: "string" },
        },
      },
      render: (_args, value) =>
        [{ type: "text", text: value?.ok ? "deadman disarmed" : `deadman not disarmed${value?.reason ? `: ${value.reason}` : ""}` }],
    },
    execute(args, exec) {
      const taskName = String(args?.name ?? "").trim();
      const force = Boolean(args?.force);
      const task = tasks.get(taskName);
      if (task === undefined) return { ok: false, reason: "no such task" };
      const caller = exec?.agent;
      if (!force && !canManage(caller, task)) {
        ctx.logger.warn(`deadman: REFUSED disarm of '${taskName}' by session ${short(caller?.id)} (armed by ${short(task.sessionId)})`);
        return {
          ok: false,
          reason: `'${taskName}' was armed by another session; refuse to disarm. Ask that session, or repeat with force=true`,
        };
      }
      if (force && !canManage(caller, task)) {
        ctx.logger.warn(`deadman: FORCED disarm of '${taskName}' by session ${short(caller?.id)} (armed by ${short(task.sessionId)})`);
      }
      tasks.delete(taskName);
      heldThisFire.delete(taskName);
      persist();
      ctx.logger.info(`deadman: disarmed '${taskName}' (was armed)`);
      return { ok: true };
    },
  }));

  // ---------- 斜杠命令 /deadman ----------
  function renderTasks(scope, sessionId) {
    const all = scope === "all";
    const rows = [...tasks.values()]
      .filter((task) => all || task.sessionId === sessionId)
      .sort((a, b) => a.dueAt - b.dueAt);
    if (rows.length === 0) {
      return all
        ? "No deadman switches armed."
        : "No deadman switch in this session. Use /deadman all to see every session.";
    }
    const lines = rows.map((task) => {
      const minutes = Math.max(0, Math.round((task.dueAt - Date.now()) / 60000));
      const owner = all ? ` [session ${short(task.sessionId)}]` : "";
      const desc = task.description ? ` (${task.description})` : "";
      return `- ${task.name}${owner} inspects in ~${minutes}min, retry every ${task.intervalMin}min, fired ${task.firedCount ?? 0}×${desc}\n  command: ${task.command}`;
    });
    const tip = all
      ? "Use /deadman cancel <name> to disarm one."
      : "Use /deadman all to see every session. /deadman cancel <name> disarms one.";
    return `Armed deadman switches:\n${lines.join("\n")}\n\n${tip}`;
  }

  ctx.effect(() => ctx.commands.register({
    definitionId: "dsh-deadman/deadman",
    name: "deadman",
    description: "list (this session) / all (every session) / cancel <name> — manage deadman switches",
    input: { hint: "[list|all|cancel <name>]" },
    handler: (invocation) => {
      const line = String(invocation?.rawInput ?? "").trim();
      const sessionId = invocation?.agent?.id;
      try {
        if (line === "" || line === "list") return { kind: "success", text: renderTasks("session", sessionId) };
        if (line === "all") return { kind: "success", text: renderTasks("all") };
        const [action, ...rest] = line.split(/\s+/);
        if (action === "cancel" || action === "disarm") {
          const taskName = rest.join(" ");
          if (!taskName) return { kind: "error", text: `Usage: /deadman cancel <name>\n${renderTasks("all")}` };
          if (!tasks.has(taskName)) return { kind: "error", text: `No switch named '${taskName}'. Run /deadman all to list them.` };
          tasks.delete(taskName);
          heldThisFire.delete(taskName);
          persist();
          ctx.logger.info(`deadman: disarmed '${taskName}' via /deadman`);
          return { kind: "success", text: `Deadman switch '${taskName}' disarmed.` };
        }
        return { kind: "error", text: `Unknown /deadman action '${action}'. Usage: /deadman [list|all|cancel <name>]` };
      } catch (err) {
        return { kind: "error", text: `deadman command failed: ${err.message}` };
      }
    },
  }), "deadman command");

  ctx.logger.info(
    `deadman: loaded (holdWindow=${config.holdWindowSeconds}s, inspect=${config.checkIntervalSeconds}s, ` +
    `maxHold=${config.maxHoldMinutes}min, questionBlock=${config.questionBlockSeconds}s, ` +
    `onUndeliverable=${config.onUndeliverable}, dataDir=${dataDir}, restored=${tasks.size} task(s))`
  );
}

export { apply, inject, name };
