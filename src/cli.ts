#!/usr/bin/env bun
import { dirname } from 'node:path'
import { type ParsedAddOptions, parseAddOptions } from './add-options.ts'
import { type AddRouteTask, selectAddRoute } from './add-route.ts'
import { openAgentSession } from './agent-session.ts'
import { askFactory } from './ask.ts'
import { type AutoUpgradeResult, maybeAutoUpgrade } from './auto-upgrade.ts'
import { addBacklog, loadBacklog, removeBacklog } from './backlog.ts'
import { runCompletion } from './completion.ts'
import { AUTO_CAP, runTask, type TaskOutcome } from './conductor.ts'
import {
  type Agent,
  ConfigError,
  globalConfigFile,
  loadContext,
  loadRepoContext,
  type WorkContext,
} from './config.ts'
import { openDeck } from './deck.ts'
import {
  type DeliverySkill,
  deliveryLabel,
  extractDeliveryDirective,
  listDeliverySkills,
  type TaskDelivery,
} from './delivery.ts'
import { composeInEditor, openEditor } from './editor.ts'
import { captureCorrection, captureEvalCase } from './evals.ts'
import {
  decideFeedbackRoute,
  feedbackRouteInput,
  followUpIntent,
  latestFeedbackTarget,
  renderTerminalFeedback,
} from './feedback.ts'
import { hasChanges, NotARepoError } from './git.ts'
import { emit, type Hooks } from './hooks.ts'
import { parseInputArgs, resolveMessage } from './input.ts'
import { readCandidates, readLessons } from './lessons.ts'
import { log } from './log.ts'
import { startPromptWorker } from './prompt.ts'
import { sharpen } from './sharpen.ts'
import {
  addTask,
  appendAnswer,
  appendFeedback,
  findTask,
  isStranded,
  latestTask,
  loadTasks,
  markFeedbackConsumed,
  nextRunnable,
  pendingFeedbackCount,
  RESUMABLE_STATUSES,
  readArtifact,
  readPlan,
  saveMeta,
  setStatus,
  setTaskDelivery,
  type Task,
} from './task.ts'
import { upgradeFactory } from './upgrade.ts'
import { FACTORY_VERSION } from './version.ts'
import { printConfig, printReport, printShow, printStatus } from './view.ts'

const HELP = `factory — a self-improving coding loop.

Queue tasks in a git worktree; work plans, implements, reviews, verifies, and
commits each one autonomously — pausing to ask you only when a task is genuinely
ambiguous. Run one instance per worktree (a fleet) and triage via tmux.

COMMANDS
  factory backlog [add|rm] …    Experimental repo-level backlog of vetted intents.
                             add/rm take the same intent forms as 'factory add';
                             automatic dispatch is not built yet.
  factory add [--raw] [--trivial | --complexity trivial|complex] [intent...] [--verify <cmd...>] [--edit]
      Tell this factory/workstream something. If a current task needs input, has
      progress, is blocked/retrying, or just completed, the input is routed into
      that task. If there is no current work, it queues a new task. A running
      'factory run' (below) is what actually picks queued work up.
      With no intent (or --edit), opens $EDITOR. The intent can also be piped on
      stdin (multi-line specs). --verify is for newly queued tasks only.
      For new tasks, the running loop triages and sharpens non-trivial pending
      intents. --raw skips sharpening; --trivial / --complexity also use the
      declared runtime complexity instead of triage. A directive like $ship or
      /ship maps to a repo skill when present; plain delivery wording is resolved
      by the run loop before implementation.

  factory run [--once | --drain] [--no-prompt]
      Work the queue. Default: stay running and pick up tasks as they're added
      (factory add), unblocked (factory retry), due for an auto-retry, or
      stranded mid-stage by a previously killed loop (Ctrl-C/crash) — shovel coal
      into the engine. So restarting after a Ctrl-C just resumes the interrupted
      task. A transient gate failure (verify/ship) is set aside and AUTO-RESUMED on
      a backoff (up to a cap) before it truly blocks, so env/CI flakes recover with
      no action from you. In watch mode on a terminal it also prompts you inline for
      needs-input answers (no need to switch terminals); the loop keeps working
      other tasks while a prompt is open.
        --once       do one ready task, then exit (good for trying it out)
        --drain      work until the queue is empty, then exit
        --no-prompt  don't prompt inline; needs-input waits for factory add

  factory retry [task-id] [-m <note> | --edit]
      Pick a BLOCKED, waiting-to-retry, or interrupted (killed mid-stage) task back
      up where it left off — it reuses the saved plan and the code already in the
      worktree and re-enters at the stage that failed, instead of re-planning from
      scratch. Omit the id for the latest such task; add an optional note (with -m or
      --edit) as fix-context for the retry. Use this for review-panel blocks (after
      you've looked) or to force a transient retry now. (Note: a running 'factory run'
      already auto-reclaims interrupted tasks; this is the manual equivalent.)
      'factory resume' is a deprecated alias.

  factory feedback [task-id] [-m <feedback> | --edit]
      Record human critique after reviewing or testing existing task work. Unlike
      'add', this is not new work; unlike 'retry', the feedback is durable and the
      next autonomous pass is told to generalize from the concrete comment before
      changing code. Omit the id for the latest sensible feedback target; pass the
      feedback with -m, or omit it to compose in $EDITOR (or pipe via stdin). Done or
      committed tasks get a linked follow-up instead of being reopened.

  factory correct [task-id] [-m <note> | --edit]
      When you take over a BLOCKED task and fix it yourself, record the lesson: it
      pairs the agent's failed attempt with your in-worktree fix, distills what it
      should have done (sharpened by your note), saves a lesson + eval case, and
      marks the task done. Run it with your fix in the worktree, before committing.
      Omit the id for the latest blocked task; add an optional note with -m or --edit.
      (The highest-signal way the factory learns — your corrections are the answer key.)

  factory status              Catch-up dashboard: what's running (and for how long),
                           what's waiting on you, what's blocked, what's done.
  factory ask [task-id] [question...]
                           Interactive Q&A over saved factory task state (TTY).
  factory ask --print [task-id] <question...>
                           One-shot, scriptable answer (required in non-TTY).
  factory session [--agent codex|claude] [task-id]
                           Open an interactive agent session seeded with saved
                           task artifacts. Defaults to codex + latest done task.
                           Shortcuts: factory codex [task-id], factory claude [task-id].
  factory deck [task-id] [--url]
                         Open the visual one-page brief for a done task.
                         Defaults to the latest done task; --url prints the
                         file URL instead.
  factory delivery [--task <id>] [none | '$skill' | /skill | <policy...>]
                           Show or set the task-local completion action. Omit the
                           value to inspect it; use none to stop after local commit.
  factory show [task-id] [step]  Drill into one task (defaults to the latest here);
                             with a step (e.g. implement, review, plan.codex), show
                             that step's line-by-line agent activity. A lone step
                             name applies to the latest task (factory show review).
  factory report [task-id] [--all]
                             Telemetry for one task (defaults to the latest here):
                             cost, cycle time, where the tokens go. --all rolls up
                             across the repo: first-pass yield, escalation/blocked rate.
  factory lessons             Curated lessons (LESSONS.md) + raw candidates.
  factory config [edit [--global|--worktree|--repo-parent|--dir <dir>]]
                           Show effective config + where it's set; edit opens the
                           global config by default; flags target another layer.
  factory version | --version    Print the current CLI version.
  factory upgrade                Update factory to the latest GitHub release.
                               Installed builds also check weekly and prompt
                               before interactive commands; FACTORY_DISABLE_AUTO_UPGRADE=1 opts out.
  factory completion zsh         Print the zsh completion script (see README to enable).

HOW A TASK FLOWS
  ready → plan (codex + claude) → cross-critique → reconcile
        → [pause & ask you, if ambiguous] → implement → review → verify
        → commit → [deliver, if selected]
  A failed gate auto-fixes and retries (config.retries) in-run before escalating.
  A transient verify/ship failure is then auto-resumed on a backoff; a review or
  review-panel block (or an exhausted retry budget) escalates: it shows in 'factory
  status' and emits the attention hook once the loop has nothing else runnable.
  The hook consumer decides whether that means a tmux color, bell, notification, or
  something else. Reply to a question with 'factory add'; pick a block back up with
  'factory retry'.

TYPICAL USE
  Try one task end to end (queue, then process it):
      factory add "Add retry to the upload client" --verify "bun test upload"
      factory run --once

  Run a continuous loop and feed it (the usual fleet mode):
      factory run                    # in a worktree; leave it running, then walk away
      factory add "Another task..."  # from anywhere; the running loop picks it up
      factory ask "has ship ran?"    # ask, then keep the session open for follow-ups
      factory session --agent claude # realtime tweak session for the latest done task
      factory add "..."              # answer, feedback, or follow-up for current work
      factory retry                  # pick a blocked task back up where it left off

  Run one loop per git worktree (each in its own tmux window) for a fleet; wire a
  hook to reflect window state (see the hooks config / README).

CONFIG (.factory.json — cascades up the dir tree, closest wins)
  dir       where state lives. Omitted → ~/.factory/sessions/<key> (or
            $FACTORY_HOME/sessions/<key>), global per-worktree. Relative = in-repo;
            absolute/~ = global.
  retries   hard-cap backstop on auto-fix iterations (default 10). Normally the
            loop stops earlier via a convergence judge: keep fixing while each
            failure is genuinely new, stop when it's going in circles.
  triage    classify each task; trivial ones skip the plan ensemble and go
            straight to implement (still reviewed + verified). default true.
  security  run a red-team security gate on the diff (default true).
            Risk and deploy-safety lenses always run in the review panel.
  ux        UI/UX lenses for user-facing work: an information-architecture
            critique in planning + a design-consistency review of the diff,
            auto-gated per task (triage flags it; review also fires when the
            diff touches UI files). default true.
  plansDir  where the clean final plan per task is written (default
            .coding-agent-plans/, committed as docs). null disables.
  captureEvals  snapshot every terminal task (done/blocked) as an eval candidate
            under the repo's eval-candidates/ (spec + verify + base commit +
            reference diff), so a regression set accrues from use. default true.
  postmortem  on a block, diagnose the root cause (writes postmortem.md) and
            distill a generalizable lesson candidate. default true.
  ask       {"agent": "claude"} configures the AI used by 'factory ask'. This is
            separate from agents.reviewer; ask is context-building over saved task
            state, not a review pipeline role.
  agents    which agent fills each role: planners (list — ≥2 cross-critique),
            implementer (also triage/reconcile/select), reviewer, delivery. Each
            is "codex"/"claude" or {"cli","model"}. default codex+claude.
  hooks     event → shell commands run at lifecycle points (stage.change,
            attention, task.done/blocked/needs_input/retrying, loop.idle). The
            payload arrives as JSON on stdin + FACTORY_* env vars; best-effort.
            This is how tmux (or notifications) integrate — factory stays agnostic.
  config edit defaults to ~/.factory/config.json (or $FACTORY_HOME/config.json).
  Use --worktree for the current repo, --repo-parent for all sibling worktrees in
  a parent-dir fleet, or --dir <dir> for a specific cascade layer. Full design:
  factory/README.md.
`

const POLL_MS = 5000

type MainOptions = {
  argv?: string[]
  autoUpgrade?: (opts: { command: string }) => Promise<AutoUpgradeResult>
  upgrade?: () => Promise<number>
  completion?: (args: string[]) => number
}

function parseAdd(args: string[]): { intent: string; verify: string | null } {
  const i = args.indexOf('--verify')
  if (i === -1) {
    return { intent: args.join(' ').trim(), verify: null }
  }
  return {
    intent: args.slice(0, i).join(' ').trim(),
    verify:
      args
        .slice(i + 1)
        .join(' ')
        .trim() || null,
  }
}

// Resolve an intent (+ verify) from args, $EDITOR (--edit or no args on a TTY),
// or stdin. Shared by `factory add` and `factory backlog add`.
async function resolveIntent(rest: string[]): Promise<{ intent: string; verify: string | null }> {
  const editFlag = rest.includes('--edit')
  const parsed = parseAdd(rest.filter((a) => a !== '--edit'))
  let intent = parsed.intent
  if (editFlag || (!intent && process.stdin.isTTY)) {
    intent = await composeInEditor(parsed.intent)
  } else if (!intent) {
    intent = (await Bun.stdin.text()).trim()
  }
  return { intent, verify: parsed.verify }
}

function queuedSuffix(opts: {
  verify: string | null
  complexity: ParsedAddOptions['complexity']
  sharpenPending: boolean
  delivery: TaskDelivery
}): string {
  const parts = []
  if (opts.complexity) {
    parts.push(opts.complexity)
  }
  if (opts.verify) {
    parts.push(`verify: ${opts.verify}`)
  }
  if (opts.sharpenPending) {
    parts.push('sharpen pending')
  }
  if (opts.delivery.mode !== 'pending') {
    parts.push(`delivery: ${deliveryLabel(opts.delivery)}`)
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

// Backlog entries are not processed by a run loop yet, so backlog add keeps the
// interactive sharpen step. Worktree `factory add` only enqueues.
async function maybeSharpen(
  root: string,
  agent: Agent,
  reviewer: Agent,
  hooks: Hooks,
  base: { intent: string; verify: string | null },
  raw: boolean
): Promise<{ intent: string; verify: string | null } | null> {
  if (raw || !process.stdin.isTTY) {
    return base
  }
  return sharpen({ root, agent, reviewer, hooks, intent: base.intent, verify: base.verify })
}

type AlertState = 'blocked' | 'needs-input' | 'done'
type ParseTaskTargetResult =
  | { ok: true; args: string[]; taskQuery: string | null }
  | { ok: false; message: string }

function parseTaskTarget(args: string[], usage: string): ParseTaskTargetResult {
  const cleaned: string[] = []
  let taskQuery: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) {
      continue
    }
    if (arg !== '--task') {
      cleaned.push(arg)
      continue
    }
    const next = args[i + 1]
    if (!next || next.startsWith('--')) {
      return { ok: false, message: usage }
    }
    if (taskQuery) {
      return { ok: false, message: usage }
    }
    taskQuery = next
    i++
  }
  return { ok: true, args: cleaned, taskQuery }
}

async function inferTaskTarget(ctx: WorkContext, taskQuery: string | null): Promise<Task> {
  if (taskQuery) {
    const task = await findTask(ctx, taskQuery)
    if (!task) {
      throw new Error(`no task matching ${taskQuery}`)
    }
    return task
  }

  const tasks = (await loadTasks(ctx)).filter((task) => task.meta.status !== 'done')
  if (tasks.length === 0) {
    throw new Error('no active task in this factory')
  }

  const live = tasks.filter((task) => isStranded(task.meta.status))
  const liveTask = live[0]
  if (live.length === 1 && liveTask) {
    return liveTask
  }
  const task = tasks[0]
  if (tasks.length === 1 && task) {
    return task
  }

  const choices = tasks.map((task) => `${task.id} (${task.meta.status})`).join(', ')
  throw new Error(`multiple active tasks; retry with --task <id>\nactive tasks: ${choices}`)
}

function manualDelivery(value: string, skills: DeliverySkill[]): TaskDelivery {
  const lower = value.toLowerCase()
  if (lower === 'none' || lower === 'disabled' || lower === 'off') {
    return {
      mode: 'none',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually disabled delivery.',
    }
  }
  const explicit = extractDeliveryDirective(value, skills).delivery
  if (explicit?.mode === 'skill') {
    return { ...explicit, source: 'manual', reason: `User manually requested ${value}.` }
  }
  return {
    mode: 'policy',
    policy: value,
    source: 'manual',
    confidence: 'high',
    reason: 'User manually set a delivery policy.',
  }
}

async function taskDelivery(ctx: WorkContext, args: string[]): Promise<number> {
  const usage = "usage: factory delivery [--task <id>] [none | '$skill' | /skill | <policy...>]"
  const parsed = parseTaskTarget(args, usage)
  if (!parsed.ok) {
    log.fail(parsed.message)
    return 1
  }
  try {
    const task = await inferTaskTarget(ctx, parsed.taskQuery)
    const value = parsed.args.join(' ').trim()
    if (value) {
      await setTaskDelivery(task, manualDelivery(value, await listDeliverySkills(ctx.root)))
      log.ok(`${task.id}: delivery set to ${deliveryLabel(task.meta.delivery)}`)
      return 0
    }
    log.log(`task: ${task.id}`)
    log.log(`delivery: ${deliveryLabel(task.meta.delivery)}`)
    if (task.meta.delivery.mode !== 'pending' && task.meta.delivery.reason) {
      log.log(`reason: ${task.meta.delivery.reason}`)
    }
    return 0
  } catch (err) {
    log.fail(err instanceof Error ? err.message : String(err))
    return 1
  }
}

// The queue's most-important state for attention and the idle label:
// blocked > needs-input > all-done > nothing.
async function queueState(ctx: WorkContext): Promise<AlertState | null> {
  const tasks = await loadTasks(ctx)
  const has = (s: string) => tasks.some((t) => t.meta.status === s)
  const allDone = tasks.length > 0 && tasks.every((t) => t.meta.status === 'done')
  return has('blocked') ? 'blocked' : has('needs-input') ? 'needs-input' : allDone ? 'done' : null
}

async function hasSavedPlan(task: Task): Promise<boolean> {
  return (await readPlan(task)) !== null
}

async function feedbackFacts(task: Task, hasWorktreeDiff: boolean) {
  return feedbackRouteInput(task, await hasSavedPlan(task), hasWorktreeDiff)
}

async function addRouteTasks(tasks: Task[]): Promise<AddRouteTask[]> {
  const routed: AddRouteTask[] = []
  for (const task of tasks) {
    routed.push({
      id: task.id,
      status: task.meta.status,
      createdAt: task.meta.createdAt,
      updatedAt: task.meta.updatedAt,
      hasPlan: await hasSavedPlan(task),
      hasCommit: task.meta.commit !== null,
      pendingFeedback: pendingFeedbackCount(task) > 0,
    })
  }
  return routed
}

function findLoadedTask(tasks: Task[], id: string): Task {
  const task = tasks.find((candidate) => candidate.id === id)
  if (!task) {
    throw new Error(`selected task disappeared: ${id}`)
  }
  return task
}

function addOptionsRequireNewTask(options: ParsedAddOptions): string | null {
  if (options.raw) {
    return '--raw only applies when add queues a new task'
  }
  if (options.complexity !== null) {
    return '--trivial/--complexity only apply when add queues a new task'
  }
  return null
}

async function queueNewTask(
  ctx: WorkContext,
  base: { intent: string; verify: string | null },
  options: ParsedAddOptions
): Promise<void> {
  // factory add only enqueues new work; the run loop sharpens non-trivial pending
  // intents. --raw, a declared complexity, or piped input all skip that sharpen
  // pre-stage — and a declared complexity also skips runtime triage.
  const skipSharpen = options.raw || options.complexity !== null || !process.stdin.isTTY
  const directed = extractDeliveryDirective(base.intent, await listDeliverySkills(ctx.root))
  const task = await addTask(ctx, directed.intent, base.verify, {
    sharpen: skipSharpen ? 'skipped' : 'pending',
    complexity: options.complexity,
    delivery: directed.delivery ?? { mode: 'pending' },
  })
  const suffix = queuedSuffix({
    verify: base.verify,
    complexity: task.meta.complexity,
    sharpenPending: task.meta.sharpen === 'pending',
    delivery: task.meta.delivery,
  })
  log.ok(`queued ${task.id}${suffix}`)
}

export async function main(opts: MainOptions = {}): Promise<number> {
  const [cmd, ...rest] = opts.argv ?? process.argv.slice(2)

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    log.log(HELP)
    return 0
  }

  if (cmd === 'version' || cmd === '--version') {
    log.log(FACTORY_VERSION)
    return 0
  }

  if (cmd === 'upgrade') {
    return await (opts.upgrade ?? upgradeFactory)()
  }

  if (cmd === 'completion') {
    return (opts.completion ?? runCompletion)(rest)
  }

  const autoUpgrade = await (opts.autoUpgrade ?? maybeAutoUpgrade)({ command: cmd })
  if (autoUpgrade.kind === 'exit') {
    return autoUpgrade.code
  }

  if (cmd === 'add') {
    const parsed = parseAddOptions(rest)
    if (!parsed.ok) {
      log.fail(parsed.message)
      return 1
    }
    const base = await resolveIntent(parsed.options.args)
    if (!base.intent) {
      log.fail('add needs an intent (argument, editor, or stdin)')
      return 1
    }
    const ctx = await loadContext(process.cwd())
    const tasks = await loadTasks(ctx)
    const route = selectAddRoute(await addRouteTasks(tasks), await hasChanges(ctx.root))
    if (route.kind === 'new-task') {
      await queueNewTask(ctx, base, parsed.options)
      return 0
    }
    const newTaskOnlyError = addOptionsRequireNewTask(parsed.options)
    if (newTaskOnlyError) {
      log.fail(newTaskOnlyError)
      return 1
    }
    if (base.verify) {
      log.fail('--verify only applies when add queues a new task')
      return 1
    }
    const task = findLoadedTask(tasks, route.taskId)
    if (route.kind === 'answer') {
      await appendAnswer(task, base.intent)
      await setStatus(task, 'ready')
      log.ok(`${task.id}: routed as answer — ${route.reason}`)
      return 0
    }
    if (route.kind === 'retry') {
      task.meta.resume = true
      task.meta.resumeNote = base.intent
      task.meta.resumeKind = 'manual'
      task.meta.autoRetries = 0
      task.meta.retryAt = null
      await setStatus(task, 'ready')
      log.ok(`${task.id}: routed as retry — ${route.reason}`)
      return 0
    }
    if (route.kind === 'feedback') {
      await appendFeedback(task, base.intent)
      task.meta.resume = true
      task.meta.resumeKind = 'manual'
      task.meta.resumeNote = null
      task.meta.autoRetries = 0
      task.meta.retryAt = null
      await setStatus(task, 'ready')
      log.ok(`${task.id}: routed as feedback — ${route.reason}`)
      return 0
    }
    if (route.recordOnSource) {
      await appendFeedback(task, base.intent)
      markFeedbackConsumed(task, task.meta.feedbackCount)
      await saveMeta(task)
    }
    const followUp = await addTask(ctx, followUpIntent(task, base.intent), task.meta.verify, {
      sharpen: 'skipped',
      feedbackSourceTaskId: task.id,
    })
    log.ok(`${task.id}: routed as follow-up — ${route.reason}; queued ${followUp.id}`)
    return 0
  }

  if (cmd === 'backlog') {
    const ctx = await loadRepoContext(process.cwd())
    const sub = rest[0]
    if (sub === 'add') {
      const raw = rest.includes('--raw')
      const base = await resolveIntent(rest.slice(1).filter((a) => a !== '--raw'))
      if (!base.intent) {
        log.fail('backlog add needs an intent (argument, editor, or stdin)')
        return 1
      }
      const refined = await maybeSharpen(
        ctx.mainRoot,
        ctx.agents.implementer,
        ctx.agents.reviewer,
        ctx.config.hooks,
        base,
        raw
      )
      if (!refined) {
        log.info('sharpen cancelled — nothing queued')
        return 0
      }
      const entry = await addBacklog(ctx, refined.intent, refined.verify)
      log.ok(`backlog +${entry.id}${refined.verify ? ` (verify: ${refined.verify})` : ''}`)
      return 0
    }
    if (sub === 'rm') {
      const id = rest[1]
      if (!id) {
        log.fail('usage: factory backlog rm <id>')
        return 1
      }
      const removed = await removeBacklog(ctx, id)
      if (!removed) {
        log.fail(`no backlog entry matching "${id}"`)
        return 1
      }
      if ('ambiguous' in removed) {
        log.fail(`ambiguous backlog id "${id}"`)
        log.info(`  matches: ${removed.ambiguous.map((entry) => entry.id).join(', ')}`)
        return 1
      }
      log.ok(`backlog -${removed.removed.id}`)
      return 0
    }
    const entries = await loadBacklog(ctx)
    if (entries.length === 0) {
      log.info('backlog empty — add with: factory backlog add "…"')
      return 0
    }
    log.log(`backlog — ${entries.length} pending`)
    for (const e of entries) {
      log.log(`  ${e.id}${e.verify ? `  (verify: ${e.verify})` : ''}`)
    }
    return 0
  }

  if (cmd === 'run') {
    const once = rest.includes('--once')
    const drain = rest.includes('--drain')
    const ctx = await loadContext(process.cwd())
    log.info(
      once ? 'running one task' : drain ? 'draining queue' : 'watching queue (Ctrl-C to stop)'
    )

    // In the long-lived watch mode, when someone is at the terminal, prompt for
    // needs-input answers inline. The worker runs concurrently — the loop keeps
    // working other tasks while a prompt is open. Bounded runs (--once/--drain) and
    // non-TTY/piped runs keep the set-aside + state-aware `factory add` behavior;
    // opt out with --no-prompt.
    const interactive = !once && !drain && process.stdin.isTTY && !rest.includes('--no-prompt')
    if (interactive) {
      startPromptWorker(ctx)
    }

    // The attention hook means "factory is stopped, waiting on you" — so it is
    // raised only when the loop has no runnable work left, never while it's
    // actively churning other tasks. Dedup by last-emitted state so a long idle
    // wait doesn't repeatedly notify hook consumers on every poll.
    let alerted: AlertState | 'none' | null = null
    const setAlert = async (state: AlertState | 'none') => {
      if (state === alerted) {
        return
      }
      alerted = state
      await emit(ctx.root, ctx.config.hooks, 'attention', { state })
    }

    // Long-lived by default: when no task is ready, wait and poll so tasks added
    // later (factory add), unblocked later (factory retry), or due for an
    // auto-retry get picked up. needs-input/blocked/retrying tasks are set aside,
    // not stopped on, so factory stays busy.
    while (true) {
      const task = await nextRunnable(ctx)
      if (!task) {
        // Nothing runnable: the loop is now genuinely waiting on you. Drive
        // attention from what's left — blocked/needs-input/done are meaningful to
        // hook consumers, an empty/all-other queue clears it. This is the only
        // place the run loop raises attention, so consumers never see "waiting on
        // you" while factory is actively working other tasks. Label the window the
        // same way via loop.idle.
        const remaining = await queueState(ctx)
        await setAlert(remaining ?? 'none')
        if (once || drain) {
          break
        }
        await emit(ctx.root, ctx.config.hooks, 'loop.idle', { state: remaining ?? 'idle' })
        await Bun.sleep(POLL_MS)
        continue
      }

      log.step(`running ${task.id}`)
      // Actively working — clear any waiting alert, announce the start.
      await setAlert('none')
      await emit(ctx.root, ctx.config.hooks, 'task.start', { task: task.id })
      // Isolate the task: any unhandled error blocks just this task (logged
      // clearly) and the loop keeps going, rather than killing the whole run.
      let outcome: TaskOutcome
      try {
        outcome = await runTask(ctx, task)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        log.fail(`${task.id}: errored — ${reason}`)
        outcome = { ok: false, kind: 'blocked', reason }
      }
      if (outcome.ok) {
        await setStatus(task, 'done')
        await captureEvalCase(ctx, task, 'done')
        await emit(ctx.root, ctx.config.hooks, 'task.done', {
          task: task.id,
          commit: task.meta.commit,
        })
        log.ok(`${task.id}: done`)
        const feedback = await readArtifact(task, 'feedback.md')
        if (feedback) {
          for (const line of renderTerminalFeedback(feedback, task.id)) {
            log.log(line)
          }
        }
        if (await readArtifact(task, 'brief.html')) {
          log.log(`brief: factory deck ${task.id}`)
        }
      } else if (outcome.kind === 'needs-input') {
        await setStatus(task, 'needs-input', 'awaiting answer — see questions.md')
        await emit(ctx.root, ctx.config.hooks, 'task.needs_input', { task: task.id })
        // In interactive mode the prompt worker announces and collects the answer
        // inline; point at state-aware `factory add` when nothing will prompt here.
        if (!interactive) {
          log.warn(`${task.id}: needs input — run: factory add "..."`)
        }
      } else if (outcome.kind === 'retrying') {
        // Transient gate failure: set aside (no alert) and let the loop auto-resume
        // it once the backoff elapses, up to the cap, before it truly blocks.
        task.meta.autoRetries = outcome.autoRetries
        task.meta.retryAt = outcome.retryAt
        await setStatus(task, 'retrying', outcome.reason)
        await emit(ctx.root, ctx.config.hooks, 'task.retrying', {
          task: task.id,
          reason: outcome.reason,
          retryAt: outcome.retryAt,
        })
        const retryCount =
          outcome.autoRetries <= AUTO_CAP
            ? `${outcome.autoRetries}/${AUTO_CAP}`
            : `${outcome.autoRetries} (past cap; judge approved)`
        const retryTime = new Date(outcome.retryAt).toLocaleTimeString()
        log.warn(`${task.id}: ${outcome.reason} — auto-retry ${retryCount} at ${retryTime}`)
      } else {
        await setStatus(task, 'blocked', outcome.reason)
        await captureEvalCase(ctx, task, 'blocked', outcome.reason)
        await emit(ctx.root, ctx.config.hooks, 'task.blocked', {
          task: task.id,
          reason: outcome.reason,
        })
        log.fail(`${task.id}: blocked — ${outcome.reason}`)
        // Surface why, inline: the first lines of the review/verify failure.
        const why = (outcome.detail ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 8)
        for (const line of why) {
          log.log(`    ${line}`)
        }
        log.info(`    detail: factory show ${task.id}  ·  retry: factory retry`)
      }

      if (once) {
        break
      }
    }
    // Exiting (--once/--drain): clear the active stage so the window drops its
    // "(stage)" suffix and the shared ▶ working-marker, rather than leaving a
    // stale "an agent is working here" indicator after the process is gone. The
    // long-lived path never reaches here — it clears via loop.idle instead.
    await emit(ctx.root, ctx.config.hooks, 'stage.change', { stage: '', active: false })
    return 0
  }

  if (cmd === 'answer') {
    const usage = 'usage: factory answer [task-id] [-m <answer> | --edit]'
    const ctx = await loadContext(process.cwd())
    log.warn('factory answer is deprecated; use factory add "..." or the inline run prompt')
    const parsed = parseInputArgs(rest, usage)
    if (!parsed.ok) {
      log.fail(parsed.error)
      return 1
    }
    const task = parsed.taskQuery
      ? await findTask(ctx, parsed.taskQuery)
      : await latestTask(ctx, ['needs-input'])
    if (!task) {
      log.fail(
        parsed.taskQuery ? `no task matching ${parsed.taskQuery}` : 'no needs-input task to answer'
      )
      return 1
    }
    const text = await resolveMessage(parsed, 'required')
    if (!text) {
      log.fail(usage)
      return 1
    }
    await appendAnswer(task, text)
    await setStatus(task, 'ready')
    log.ok(`${task.id}: answered, back in queue`)
    return 0
  }

  if (cmd === 'feedback') {
    const usage = 'usage: factory feedback [task-id] [-m <feedback> | --edit]'
    const ctx = await loadContext(process.cwd())
    const parsed = parseInputArgs(rest, usage)
    if (!parsed.ok) {
      log.fail(parsed.error)
      return 1
    }
    const hasWorktreeDiff = await hasChanges(ctx.root)
    let task: Task | null
    if (parsed.taskQuery) {
      task = await findTask(ctx, parsed.taskQuery)
    } else {
      const tasks = await loadTasks(ctx)
      const hasPlanEntries: Array<[string, boolean]> = []
      for (const candidate of tasks) {
        hasPlanEntries.push([candidate.id, await hasSavedPlan(candidate)])
      }
      const hasPlanByTask = new Map(hasPlanEntries)
      task = latestFeedbackTarget(tasks, (candidate) =>
        feedbackRouteInput(candidate, hasPlanByTask.get(candidate.id) ?? false, hasWorktreeDiff)
      )
    }
    if (!task) {
      log.fail(
        parsed.taskQuery
          ? `no task matching ${parsed.taskQuery}`
          : 'no feedback target with existing progress'
      )
      return 1
    }
    const route = decideFeedbackRoute(await feedbackFacts(task, hasWorktreeDiff))
    if (route.kind === 'reject') {
      log.fail(route.message)
      return 1
    }
    // Resolve the message only after the task can actually take feedback, so a
    // rejected route never makes the user write into an editor for nothing.
    const text = await resolveMessage(parsed, 'required')
    if (!text) {
      log.fail(usage)
      return 1
    }
    if (route.kind === 'follow-up') {
      await appendFeedback(task, text)
      markFeedbackConsumed(task, task.meta.feedbackCount)
      await saveMeta(task)
      const followUp = await addTask(ctx, followUpIntent(task, text), task.meta.verify, {
        sharpen: 'skipped',
        feedbackSourceTaskId: task.id,
      })
      log.ok(`${task.id}: done — queued follow-up ${followUp.id} for feedback`)
      return 0
    }

    await appendFeedback(task, text)
    task.meta.resume = true
    task.meta.resumeKind = 'manual'
    task.meta.resumeNote = null
    task.meta.autoRetries = 0
    task.meta.retryAt = null
    await setStatus(task, 'ready')
    log.ok(`${task.id}: feedback recorded — back in queue`)
    return 0
  }

  if (cmd === 'retry' || cmd === 'resume') {
    // Pick up a stuck task where it left off — reuse its plan + diff, no re-plan.
    // id optional (defaults to the latest blocked/retrying task, or one stranded
    // mid-stage by a killed loop). The note is optional and only set via -m/--edit,
    // so a bare `factory retry` still just retries.
    const usage = `usage: factory ${cmd} [task-id] [-m <note> | --edit]`
    const ctx = await loadContext(process.cwd())
    const parsed = parseInputArgs(rest, usage)
    if (!parsed.ok) {
      log.fail(parsed.error)
      return 1
    }
    const task = parsed.taskQuery
      ? await findTask(ctx, parsed.taskQuery)
      : await latestTask(ctx, RESUMABLE_STATUSES)
    if (!task) {
      log.fail(
        parsed.taskQuery
          ? `no task matching ${parsed.taskQuery}`
          : 'no resumable task (blocked, retrying, or interrupted mid-stage)'
      )
      return 1
    }
    const note = await resolveMessage(parsed, 'optional')
    task.meta.resume = true
    task.meta.resumeNote = note
    task.meta.resumeKind = 'manual'
    // Manual retry restores the full auto-retry budget for transient failures.
    task.meta.autoRetries = 0
    task.meta.retryAt = null
    await setStatus(task, 'ready')
    log.ok(`${task.id}: retrying — back in queue${note ? ' with note' : ''}`)
    return 0
  }

  if (cmd === 'correct') {
    // Record a manual takeover of a blocked task: pair the agent's attempt with your
    // in-worktree fix into a lesson + eval case, then mark it done. id optional
    // (latest blocked); the note is optional and only set via -m/--edit.
    const usage = 'usage: factory correct [task-id] [-m <note> | --edit]'
    const ctx = await loadContext(process.cwd())
    const parsed = parseInputArgs(rest, usage)
    if (!parsed.ok) {
      log.fail(parsed.error)
      return 1
    }
    const task = parsed.taskQuery
      ? await findTask(ctx, parsed.taskQuery)
      : await latestTask(ctx, ['blocked'])
    if (!task) {
      log.fail(
        parsed.taskQuery ? `no task matching ${parsed.taskQuery}` : 'no blocked task to correct'
      )
      return 1
    }
    const note = await resolveMessage(parsed, 'optional')
    await captureCorrection(ctx, task, note ?? '')
    await setStatus(task, 'done')
    log.ok(`${task.id}: correction recorded, marked done`)
    return 0
  }

  if (cmd === 'status') {
    const ctx = await loadContext(process.cwd())
    await printStatus(ctx)
    return 0
  }

  if (cmd === 'ask') {
    const ctx = await loadContext(process.cwd())
    return askFactory(ctx, rest)
  }

  if (cmd === 'session') {
    const ctx = await loadContext(process.cwd())
    return openAgentSession(ctx, rest, { commandName: 'session' })
  }

  if (cmd === 'deck') {
    const ctx = await loadContext(process.cwd())
    return openDeck(ctx, rest)
  }

  if (cmd === 'delivery') {
    const ctx = await loadContext(process.cwd())
    return taskDelivery(ctx, rest)
  }

  if (cmd === 'codex' || cmd === 'claude') {
    const ctx = await loadContext(process.cwd())
    return openAgentSession(ctx, rest, { defaultAgent: cmd, commandName: cmd })
  }

  if (cmd === 'config') {
    const ctx = await loadContext(process.cwd())
    if (['set', 'get', 'unset', 'inherit'].includes(rest[0] ?? '')) {
      log.fail('task delivery moved out of config; use: factory delivery [--task <id>] ...')
      return 1
    }
    if (rest[0] === 'edit') {
      const dirFlag = rest.indexOf('--dir')
      const explicitDir = dirFlag === -1 ? null : rest[dirFlag + 1]
      if (dirFlag !== -1 && !explicitDir) {
        log.fail('usage: factory config edit --dir <dir>')
        return 1
      }
      const legacyDir = rest[1] && !rest[1].startsWith('--') ? rest[1] : null
      const target = rest.includes('--worktree')
        ? ctx.root
        : rest.includes('--repo-parent')
          ? dirname(ctx.root)
          : explicitDir
            ? explicitDir
            : legacyDir
      const path = target
        ? `${target.replace(/^~/, process.env['HOME'] ?? '~')}/.factory.json`
        : globalConfigFile()
      if (!(await Bun.file(path).exists())) {
        await Bun.write(path, '{}\n')
      }
      log.info(`editing ${path}`)
      await openEditor(path)
      return 0
    }
    await printConfig(ctx)
    return 0
  }

  if (cmd === 'show') {
    const ctx = await loadContext(process.cwd())
    return printShow(ctx, rest[0], rest[1])
  }

  if (cmd === 'lessons') {
    const ctx = await loadContext(process.cwd())
    log.log('## LESSONS.md (curated — read by the planner each run)')
    log.log((await readLessons(ctx)) ?? '(none yet)')
    log.log('')
    log.log('## candidates (raw signal — curate the recurring ones into LESSONS.md)')
    log.log((await readCandidates(ctx)) ?? '(none yet)')
    return 0
  }

  if (cmd === 'report') {
    const ctx = await loadContext(process.cwd())
    // Default to the current task (like `show`); `--all` for the repo roll-up.
    if (rest.includes('--all')) {
      printReport(ctx)
      return 0
    }
    const query = rest.find((a) => !a.startsWith('-'))
    const task = query ? await findTask(ctx, query) : await latestTask(ctx)
    if (!task) {
      if (query) {
        log.fail(`no task matching "${query}"`)
        return 1
      }
      log.info('no tasks in this worktree — use `factory report --all` for the repo roll-up')
      return 0
    }
    printReport(ctx, task.id)
    return 0
  }

  log.fail(`unknown command: ${cmd}`)
  log.log(HELP)
  return 1
}

// A bad config or running outside a repo is user error, not a crash: print it
// cleanly and exit. Anything else is an unexpected bug — let it throw so the
// stack trace is preserved.
export async function runCli(): Promise<void> {
  try {
    process.exit(await main())
  } catch (err) {
    if (err instanceof ConfigError || err instanceof NotARepoError) {
      log.fail(err.message)
      process.exit(1)
    }
    throw err
  }
}

if (import.meta.main) {
  await runCli()
}
