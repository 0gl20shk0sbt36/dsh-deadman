/**
 * dsh-deadman 假宿主测试（不依赖 dsh 进程、不联网）
 *
 * 用假的 ctx + 假 agent 驱动插件真实代码，专门覆盖三条"闸门"里之前没实测的部分：
 *   A. progressScope: global —— 别的 agent 在推进时不得开火
 *   B. progressScope: owner  —— 别的 agent 在推进时不受影响，照样开火
 *   C. 提问阻塞闸门 —— 有 open 提问时按 questionBlockSeconds 放行（而不是等满 holdWindow）
 *   D. maxHoldMinutes —— 一直在推进也不能无限拖，到顶必须开火
 *
 * 用法: node tests/fake-host.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN = pathToFileURL(new URL("../lib/index.js", import.meta.url).pathname).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 可选场景过滤：node tests/fake-host.mjs E 只跑标题以 E 开头的场景。 */
const FILTER = process.argv[2] ?? "";

/** 造一个假 agent：只实现插件真正用到的那几个字段/方法。 */
function makeAgent(id, { onSend } = {}) {
  return {
    id,
    status: "idle",
    session: { seq: 0, header: { cwd: "/tmp" } },
    sent: [],
    injections: [],
    send(message) {
      this.sent.push(message);
      onSend?.(this, message);
    },
    inject(message) {
      this.injections.push(message);
    },
    followup() {},
  };
}

/**
 * 造一个假宿主上下文并挂载插件。
 * @returns {{tools:Map, ctx:object, stop:()=>void}}
 */
async function mountPlugin(config, { agents, projections } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "deadman-test-"));
  const tools = new Map();
  const disposers = [];
  const agentList = agents ?? [];

  const ctx = {
    logger: { info: () => {}, warn: (m) => console.log("   [warn]", m) },
    agents: {
      get: (id) => agentList.find((a) => a.id === id),
      list: () => agentList,
      resume: async () => {
        throw new Error("no live session to resume (fake host)");
      },
      // 假宿主里只有直接子代理关系：child.parent === owner.id
      isOwnedBy: (childId, owner) => agentList.some((a) => a.id === childId && a.parent === owner.id),
    },
    get: (name) => (name === "sessionProjections" ? projections : undefined),
    tools: { register: (def) => tools.set(def.name, def) },
    commands: { register: (def) => ({ dispose() {}, def }) },
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer === "function") disposers.push(disposer);
      return { dispose: () => disposer?.() };
    },
  };

  const plugin = await import(PLUGIN);
  plugin.apply(ctx, { dataDir, ...config });

  return {
    tools,
    ctx,
    stop: () => {
      for (const d of disposers) d();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 挂一个"推进"驱动器：定期推进指定 agent 的 session.seq。 */
function drive(agent, everyMs, state) {
  const timer = setInterval(() => {
    agent.session.seq += 1;
    state.ticks += 1;
  }, everyMs);
  return () => clearInterval(timer);
}

async function scenario({ title, expect, run }) {
  if (FILTER && !title.startsWith(FILTER)) return null; // 不在过滤范围
  process.stdout.write(`\n▶ ${title}\n`);
  const t0 = Date.now();
  const ok = await run();
  const ms = Date.now() - t0;
  console.log(`   ${ok ? "✅ PASS" : "❌ FAIL"} (耗时 ${(ms / 1000).toFixed(1)}s) — 期望: ${expect}`);
  return ok;
}

const results = [];
const TICK = 1000; // checkIntervalSeconds = 1

// ---------- A. global 范围：别的 agent 在推进 ⇒ 不开火 ----------
results.push(await scenario({
  title: "A. progressScope=global：无关 agent 持续推进时不得开火",
  expect: "前 12s 不开火；停掉推进后 ~6s 内开火",
  run: async () => {
    const fired = join(mkdtempSync(join(tmpdir(), "deadman-out-")), "a.txt");
    const owner = makeAgent("session-owner-A");
    const unrelated = makeAgent("session-unrelated-A");
    const host = await mountPlugin(
      { holdWindowSeconds: 6, checkIntervalSeconds: 1, progressScope: "global", maxHoldMinutes: 30 },
      { agents: [owner, unrelated] }
    );
    try {
      host.tools.get("deadman_arm").execute(
        { name: "g", command: `date +%s >> ${fired}`, after_minutes: 0, interval_minutes: 5, description: "t" },
        { agent: owner }
      );
      let state = { ticks: 0 };
      const stopDrive = drive(unrelated, 500, state);
      await sleep(13_000);
      const early = existsSync(fired);
      stopDrive();
      await sleep(8_000);
      const late = existsSync(fired);
      console.log(`   推进次数=${state.ticks}；13s 时开火=${early}；21s 时开火=${late}`);
      return early === false && late === true;
    } finally {
      host.stop();
    }
  },
}));

// ---------- B. owner 范围：别的 agent 在推进 ⇒ 照样开火 ----------
results.push(await scenario({
  title: "B. progressScope=owner：无关 agent 推进不影响本看门狗",
  expect: "无关 agent 一直推进的情况下，~6s 后仍然开火",
  run: async () => {
    const fired = join(mkdtempSync(join(tmpdir(), "deadman-out-")), "b.txt");
    const owner = makeAgent("session-owner-B");
    const unrelated = makeAgent("session-unrelated-B");
    const host = await mountPlugin(
      { holdWindowSeconds: 6, checkIntervalSeconds: 1, progressScope: "owner", maxHoldMinutes: 30 },
      { agents: [owner, unrelated] }
    );
    try {
      host.tools.get("deadman_arm").execute(
        { name: "o", command: `date +%s >> ${fired}`, after_minutes: 0, interval_minutes: 5, description: "t" },
        { agent: owner }
      );
      const stopDrive = drive(unrelated, 500, { ticks: 0 });
      await sleep(12_000);
      stopDrive();
      const firedNow = existsSync(fired);
      console.log(`   12s 时开火=${firedNow}（无关 agent 全程推进）`);
      return firedNow === true;
    } finally {
      host.stop();
    }
  },
}));

// ---------- C. 提问阻塞闸门：按 questionBlockSeconds 放行 ----------
results.push(await scenario({
  title: "C. 提问阻塞：有 open 提问时按 questionBlockSeconds 放行（不等满 holdWindow）",
  expect: "holdWindow=60 但 questionBlock=3 ⇒ ~4s 内开火（对照组见 D 之外的日志）",
  run: async () => {
    const fired = join(mkdtempSync(join(tmpdir(), "deadman-out-")), "c.txt");
    const owner = makeAgent("session-owner-C");
    const projections = {
      stateOf: () => ({ questions: { active: [{ callId: "call-1", state: "open" }] } }),
    };
    const host = await mountPlugin(
      { holdWindowSeconds: 60, checkIntervalSeconds: 1, maxHoldMinutes: 30, questionBlockSeconds: 3 },
      { agents: [owner], projections }
    );
    try {
      host.tools.get("deadman_arm").execute(
        { name: "q", command: `date +%s >> ${fired}`, after_minutes: 0, interval_minutes: 5, description: "t" },
        { agent: owner }
      );
      await sleep(8_000);
      const firedNow = existsSync(fired);
      console.log(`   8s 时开火=${firedNow}（若走 holdWindow 需 60s）`);
      return firedNow === true;
    } finally {
      host.stop();
    }
  },
}));

// ---------- C2. 对照：没有提问时不受 questionBlock 影响 ----------
results.push(await scenario({
  title: "C2. 对照组：无提问时 questionBlock 不生效（要等满 holdWindow）",
  expect: "holdWindow=15 ⇒ 8s 时不开火、18s 时开火",
  run: async () => {
    const fired = join(mkdtempSync(join(tmpdir(), "deadman-out-")), "c2.txt");
    const owner = makeAgent("session-owner-C2");
    const projections = { stateOf: () => ({ questions: { active: [] } }) };
    const host = await mountPlugin(
      { holdWindowSeconds: 15, checkIntervalSeconds: 1, maxHoldMinutes: 30, questionBlockSeconds: 3 },
      { agents: [owner], projections }
    );
    try {
      host.tools.get("deadman_arm").execute(
        { name: "c2", command: `date +%s >> ${fired}`, after_minutes: 0, interval_minutes: 5, description: "t" },
        { agent: owner }
      );
      await sleep(8_000);
      const early = existsSync(fired);
      await sleep(10_000);
      const late = existsSync(fired);
      console.log(`   8s 时=${early}；18s 时=${late}`);
      return early === false && late === true;
    } finally {
      host.stop();
    }
  },
}));

// ---------- D. maxHoldMinutes：一直推进也得到顶开火 ----------
results.push(await scenario({
  title: "D. maxHoldMinutes：持续推进（holdWindow 永不满足）也必须到顶开火",
  expect: "holdWindow=999、maxHold=1min ⇒ ~60-65s 内开火",
  run: async () => {
    const fired = join(mkdtempSync(join(tmpdir(), "deadman-out-")), "d.txt");
    const owner = makeAgent("session-owner-D");
    const host = await mountPlugin(
      { holdWindowSeconds: 999, checkIntervalSeconds: 1, maxHoldMinutes: 1, progressScope: "owner" },
      { agents: [owner] }
    );
    try {
      host.tools.get("deadman_arm").execute(
        { name: "m", command: `date +%s >> ${fired}`, after_minutes: 0, interval_minutes: 5, description: "t" },
        { agent: owner }
      );
      const stopDrive = drive(owner, 500, { ticks: 0 });
      await sleep(70_000);
      stopDrive();
      const firedNow = existsSync(fired);
      console.log(`   70s 时开火=${firedNow}（holdWindow=999s 永不满足）`);
      return firedNow === true;
    } finally {
      host.stop();
    }
  },
}));

// ---------- E. serializeCommands：两条命令必须串行 ----------
results.push(await scenario({
  title: "E. serializeCommands=true：同一进程内两条动作命令串行（区间不重叠）",
  expect: "先开火那条的 end ≤ 后开火那条的 start",
  run: async () => {
    const out = join(mkdtempSync(join(tmpdir(), "deadman-out-")), "e.txt");
    const owner = makeAgent("session-owner-E");
    const host = await mountPlugin(
      { holdWindowSeconds: 2, checkIntervalSeconds: 1, maxHoldMinutes: 30, serializeCommands: true },
      { agents: [owner] }
    );
    try {
      const cmd = (tag) =>
        `echo ${tag}-start $(date +%s.%N) >> ${out}; sleep 3; echo ${tag}-end $(date +%s.%N) >> ${out}`;
      for (const name of ["s1", "s2"]) {
        host.tools.get("deadman_arm").execute(
          { name, command: cmd(name), after_minutes: 0, interval_minutes: 5, description: "t" },
          { agent: owner }
        );
      }
      await sleep(20_000);
      const lines = existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean) : [];
      console.log("   " + lines.join(" | "));
      const times = {};
      for (const line of lines) {
        // 形如 "s1-start 1790770239.773573841"
        const parts = line.trim().split(/\s+/);
        if (parts.length !== 2) continue;
        const cut = parts[0].lastIndexOf("-");
        const tag = parts[0].slice(0, cut);
        const kind = parts[0].slice(cut + 1);
        times[tag] ??= {};
        times[tag][kind] = Number(parts[1]);
      }
      const tags = Object.keys(times).filter((t) => times[t]?.start && times[t]?.end);
      if (tags.length < 2) return false;
      tags.sort((x, y) => times[x].start - times[y].start);
      const [first, second] = tags;
      const serial = times[first].end <= times[second].start + 0.01;
      console.log(`   串行检查: ${first}.end=${times[first].end} ≤ ${second}.start=${times[second].start} → ${serial}`);
      return serial;
    } finally {
      host.stop();
    }
  },
}));

const ran = results.filter((r) => r !== null);
console.log(`\n=== 汇总: ${ran.filter(Boolean).length}/${ran.length} 通过 ===`);
process.exit(ran.every(Boolean) ? 0 : 1);
