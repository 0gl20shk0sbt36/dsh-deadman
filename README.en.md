# dsh-deadman

English | [中文](README.md)

A **deadman switch** for DeepSeek Harness (dsh): once armed, it periodically checks whether any work is still advancing, and runs your command when nobody holds it off.

Built for unattended long runs — overnight builds, training, batch rendering, cloud batch jobs. A plain "shut down at 03:00" kills work that is still running; a deadman switch asks the opposite question: **is anybody still making progress? If nobody is, reclaim the resource.**

## How it differs from the built-in scheduled tasks

| | built-in `dsh-schedule` | dsh-deadman |
|---|---|---|
| What happens when due | a message is enqueued into the session inbox and **the model decides what to do** | the configured **shell command runs directly**, no model involved |
| Blocking mechanism | none | **hold gate**: while any agent keeps advancing, execution is postponed; it runs only when nobody holds |
| Fits | calendar reminders, waking a session | unattended stop-loss: shut the machine or instance down once the work is done or the agent is gone |

They complement each other. The built-in scheduler assumes the model is alive to handle the message; the moment a resource should be reclaimed is often exactly the moment the model has died or run out of quota.

## Install

Requires dsh **0.2.0-rc.2** (`peerDependencies` are pinned exactly; dsh refuses to install plugins whose peers do not match, and says so).

```sh
# from a local path
dsh plugin --profile web add /path/to/dsh-deadman

# or from GitHub
dsh plugin --profile web add github:OWNER/dsh-deadman
```

Web / Desktop: enable **dsh-deadman** on the Plugins page. CLI: `dsh plugin --profile <name> remove dsh-deadman` to uninstall.

> Install it into a **long-running** profile (such as `web`); see [Known limitations](#known-limitations).
> Dependencies are pinned to 0.2.0-rc.2. Installing from GitHub lets pnpm install them from `dependencies`; installing from a **local path** uses pnpm's `link:` protocol, which does not resolve dependencies — run `pnpm install` inside the plugin directory first so its own `node_modules` exists.

## Model-facing tools

| Tool | Purpose |
|---|---|
| `deadman_arm` | Arm: `name` / `command` / `after_minutes` / `interval_minutes` / `description`. First inspection after `after_minutes`; a held round re-inspects after `interval_minutes`; **one successful execution ends the task**, nothing has to be cancelled afterwards |
| `deadman_hold` | Report "still working": skip the current round and re-arm. **Any session may hold** (fail-safe semantics) |
| `deadman_disarm` | Disarm. Only the arming session (or one of its direct subagents) may; other sessions need an explicit `force=true`, which is logged |

Task names are **globally unique within the process**; arming an existing name is rejected and names the session that owns it.

Slash command: `/deadman` (this session) · `/deadman all` (every session) · `/deadman cancel <name>`.

## Decision order of one firing

1. **Resolve the owning session**: try `ctx.agents.get()`; if the session is not open, `ctx.agents.resume()` brings it back so delivery cannot fall into a black hole.
2. **Deliver the inspection notice** with `agent.send(message, "next-step", true)` — a running agent sees it at its next step boundary, an idle one is woken. The notice explicitly forbids asking the user or requesting confirmation: hold, or stay silent.
3. **Inspection loop**, keyed on **progress** rather than status:
   - any agent produced new session events since the last check (`session.seq` advanced) ⇒ still advancing, keep waiting;
   - nothing advanced ⇒ start the grace window `holdWindowSeconds`;
   - a pending user question exists (`state === 'open'` in the `userQuestions` projection) ⇒ timed separately, released after at most `questionBlockSeconds`;
   - total ceiling `maxHoldMinutes` since the firing — whatever happens, it runs when the ceiling is reached (fail-open).
4. **Released** ⇒ run the command; on success the task **finishes by itself** and leaves a notice for the owner; if it was held ⇒ re-arm for the next interval.

## Hold channels

1. the `deadman_hold` tool (the lead agent, or a subagent granted it);
2. a marker file `.deadman-hold-<name>` in the current working directory (useful when a subagent's tool allowlist has no `deadman_hold`);
3. a file named after the task inside the plugin's `hold/` directory (external scripts, manual intervention).

## Behaviour with several sessions

- Every task remembers its **owning session** and asks only that session; while the owner is running it also notifies other running agents (the ones actually doing the work).
- The progress criterion is **global** by default (`progressScope: global`): as long as anything anywhere still advances, every switch waits — the correct semantics for "shut the machine down". Set `progressScope: owner` to watch only the owner and its direct subagents.
- Switches that come due together **run their commands concurrently** (there is no global lock); enable `serializeCommands` to queue them instead.
- Holding is unrestricted (anyone may call work off); **disarming is restricted** (see `deadman_disarm`).

## Configuration

Override the bundle defaults in the profile's `cordis.patch.yml`:

```yaml
- id: deadman
  config:
    holdWindowSeconds: 60
```

| Key | Default | Meaning |
|---|---|---|
| `holdWindowSeconds` | `60` | how long to wait after every agent stopped advancing before executing |
| `checkIntervalSeconds` | `20` | inspection period |
| `maxHoldMinutes` | `30` | total ceiling counted from the firing; released unconditionally when reached |
| `questionBlockSeconds` | `600` | longest wait while blocked by a pending user question, then released |
| `onUndeliverable` | `execute` | when the owning session cannot be delivered to at all: `execute` anyway / `skip` this round |
| `progressScope` | `global` | progress criterion: `global` (whole harness) or `owner` (owner plus its direct subagents) |
| `serializeCommands` | `false` | queue action commands instead of running them concurrently |
| `commandTimeoutSeconds` | `300` | execution timeout of a single action command |
| `dataDir` | `$DSH_HOME/plugins/dsh-deadman` | data directory (`tasks.json` + `hold/`) |

## Data and persistence

- `tasks.json`: the task table, loaded at plugin start and **durable across restarts** (an overdue task is handled on the next inspection).
- `hold/`: external hold markers.
- Fields: `name` / `command` / `description` / `dueAt` / `intervalMin` / `sessionId` / `createdAt` / `firedCount`.

## Known limitations

- **Only effective in a long-running instance**: the scheduler lives inside the dsh process. A switch armed in a one-shot headless process has nobody to inspect it after that process exits (unless a later long-running instance loads it at boot).
- **Single-writer assumption**: `tasks.json` is a plain JSON file; concurrent writers overwrite each other. Do not arm from several processes at once — the plugin is meant to be installed only in the long-running profile.
- `progressScope: owner` counts the owner and its **direct** subagents only; deeper descendants are not counted.
- The question gate depends on the `userQuestions` session projection; without that projection the gate is simply inactive (the other gates still apply, nothing is misjudged).
- Exactly-once execution is not guaranteed: a host crash can leave an executed action unrecorded.
- The three gates (both `progressScope` values, the question-block release, and the `maxHoldMinutes` ceiling) are covered by the fake-host suite in `npm test` (`tests/fake-host.mjs`, deterministic). **Not** covered: the real 600-second question timeout inside a live session, and arming from several processes.

## Safety

- The command is **entirely caller-supplied**: only schedule commands you trust.
- The default semantics are **fail-open** (nobody holds ⇒ it runs). That is the point of a deadman switch, but choose sensible intervals and grace windows for destructive actions.
- The plugin makes no network calls and collects nothing; it only writes inside its own data directory.

## Development

```sh
pnpm install            # dependencies are pinned to 0.2.0-rc.2
node --check lib/index.js
```

**Restart the dsh process** after changing the code: ESM modules are loaded at startup, and hot reload only covers the profile configuration layer.

## License

MIT
