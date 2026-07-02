#!/usr/bin/env bun
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { type ParsedAddOptions, parseAddOptions } from './add-options.ts'
import { type AddRouteTask, selectAddRoute } from './add-route.ts'
import { openAgentSession } from './agent-session.ts'
import { agentLabel, runAgent } from './agents.ts'
import { askFactory } from './ask.ts'
import { type AutoUpgradeResult, maybeAutoUpgrade } from './auto-upgrade.ts'
import { addBacklog, type BacklogEntry, loadBacklog, removeBacklog } from './backlog.ts'
import { runCompletion } from './completion.ts'
import { AUTO_CAP, runTask, type TaskOutcome } from './conductor.ts'
import {
  type Agent,
  ConfigError,
  dispatchLogsDir,
  globalConfigFile,
  globalSkillsDir,
  loadContext,
  loadRepoContext,
  type RepoContext,
  repoConfigFile,
  sessionsDir,
  type WorkContext,
  worktreeMarkerPath,
} from './config.ts'
import { openDeck } from './deck.ts'
import {
  deliveryLabel,
  extractDeliveryDirective,
  listDeliverySkills,
  parseManualDelivery,
  type TaskDelivery,
} from './delivery.ts'
import { composeInEditor, openEditor } from './editor.ts'
import { appendEvalResult, factoryInvocation, listEvalCases, runEvalCase } from './eval-run.ts'
import { captureCorrection, captureEvalCase } from './evals.ts'
import { run } from './exec.ts'
import {
  decideFeedbackRoute,
  feedbackRouteInput,
  followUpIntent,
  latestFeedbackTarget,
  renderTerminalFeedback,
} from './feedback.ts'
import { hasChanges, NotARepoError, repoRoot } from './git.ts'
import {
  deleteGuidance,
  editGuidance,
  findGuidance,
  GUIDANCE_STAGE_VALUES,
  type GuidanceRecord,
  type GuidanceStage,
  GuidanceStageSchema,
  listGuidance,
  scopeForContext,
} from './guidance.ts'
import { harvestTask, logHarvest } from './harvest.ts'
import { emit, type Hooks } from './hooks.ts'
import { parseInputArgs, resolveMessage } from './input.ts'
import { readCandidates, readLessons } from './lessons.ts'
import { acquireRunLock, RunLockError, runLockHolder } from './lock.ts'
import { log } from './log.ts'
import { parseMoot } from './markers.ts'
import { startPromptWorker } from './prompt.ts'
import { mootCheckPrompt, taskNamePrompt } from './prompts.ts'
import { parseFormattedQuestions, sharpen } from './sharpen.ts'
import {
  addTask,
  answerTask,
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

Run a single-lane workstream in a git worktree. You tell the factory what to do;
it plans, implements, reviews, verifies, and commits autonomously — pausing to ask
you only when the current task is genuinely ambiguous. Run one instance per
worktree (a fleet) and triage via tmux.

COMMANDS
  factory backlog [add|rm] …    Repo-level backlog of vetted intents, drained by
                             'factory dispatch'. add/rm take the same intent
                             forms as 'factory add'.
  factory dispatch [--limit N] [--dry-run]
      Spawn one workstream per backlog item through the configured dispatch.spawn
      command (your worktree/tmux bootstrap tooling). Factory hands each item to
      the spawner with FACTORY_INTENT/FACTORY_NAME/FACTORY_VERIFY in the
      environment; exit 0 removes it from the backlog.
  factory add [--raw] [--trivial | --complexity trivial|complex] [--force-new] [--name <slug>] [intent...] [--verify <cmd...>] [--edit]
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
      by the run loop before planning/implementation.
      One ACTIVE task per workstream is enforced: queueing a second fresh task is
      an error (use a new worktree, or --force-new to batch deliberately).
      --name <slug> names the task directly (skips the AI namer) — for spawner
      tools that already named the worktree.

  factory run [--once | --drain | --until-done] [--no-prompt]
      Work the stream. Default: stay running and pick up tasks as they're added
      (factory add), unblocked (factory retry), due for an auto-retry, or
      stranded mid-stage by a previously killed loop (Ctrl-C/crash) — shovel coal
      into the engine. So restarting after a Ctrl-C just resumes the interrupted
      task. A transient gate failure (verify/ship) is set aside and AUTO-RESUMED on
      a backoff (up to a cap) before it truly blocks, so env/CI flakes recover with
      no action from you. In watch mode on a terminal it also prompts you inline for
      needs-input answers (no need to switch terminals); set-aside work can still
      be resumed later.
      One run loop per worktree is enforced with a lock; a second loop fails fast.
        --once        do one ready task, then exit (good for trying it out)
        --drain       work until the stream is idle, then exit
        --until-done  exit 0 when the workstream's task completes, 2 when it
                      blocks — the spawner-teardown contract
        --no-prompt   don't prompt inline; needs-input waits for factory add

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
  factory evals [list | run [case] [--keep]]
      Replay harvested eval candidates against the CURRENT factory build in a
      throwaway worktree + isolated FACTORY_HOME, scoring outcome + touched-file
      overlap vs the captured reference. The regression gate for prompt/policy
      changes and for changes to factory itself.

  factory harvest [task-id] [--all]
      Post-ship feedback: find human rework commits (anything after factory's
      recorded commit on the shipped branch) and MR discussion (gh/glab,
      best-effort) for done tasks; writes harvest.md + lesson candidates.

  factory close [task-id] [-m <reason> | --edit]
      Terminally close a parked task without a commit — abandoned or superseded
      (the loop flags likely-moot tasks whose intent already landed elsewhere).

  factory gc [--dry-run]
      Prune per-worktree session state whose worktree no longer exists (spawned
      workstreams are ephemeral). Repo-level state (metrics, lessons, evals,
      delivery history, env playbook) is never touched.

  factory report [task-id] [--all]
                             Telemetry for one task (defaults to the latest here):
                             cost, cycle time, where the tokens go. --all rolls up
                             across the repo: first-pass yield, escalation/blocked rate.
  factory lessons [list|show|rm|edit] ...
                             Learned lessons, legacy lessons, and raw candidates.
  factory config [edit [--global|--repo|--worktree|--repo-parent|--dir <dir>]]
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

  Run a continuous workstream and feed it (the usual fleet mode):
      factory run                    # in a worktree; leave it running, then walk away
      factory add "..."              # answer, feedback, follow-up, or new work
      factory ask "has ship ran?"    # ask, then keep the session open for follow-ups
      factory session --agent claude # realtime tweak session for the latest done task
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
  security  keep the red-team security gate in the review safety floor
            (default true).
  workforce let a read-only router choose research scouts, optional review
            lenses, lens agents, and specialist policies for complex tasks.
            malformed output falls back to legacy defaults. default true.
  rescue    run a last-chance read-only strategist before terminal blocks.
            default true.
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
  Use --repo for the repo-identity layer (all worktrees of this repo, this
  machine, nothing committed), --worktree for the current worktree, --repo-parent
  for a parent-dir fleet, or --dir <dir> for a specific cascade layer.
  factory skills [list | edit <name> [--repo|--global|--committed]] manages
  delivery skills the same way — --repo is the same repo-identity layer. Full design:
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

function guidanceScopeText(record: GuidanceRecord): string {
  if (record.scope.kind === 'global') {
    return 'global'
  }
  return `repo ${record.scope.repoStateDir}`
}

function printGuidanceRecord(record: GuidanceRecord): void {
  log.log(`${record.id} [${record.status}]`)
  log.log(`scope: ${guidanceScopeText(record)}`)
  log.log(`stages: ${record.stages.join(', ')}`)
  log.log(`source: ${record.source.kind}${record.source.taskId ? ` ${record.source.taskId}` : ''}`)
  if (record.source.detail) {
    log.log(`detail: ${record.source.detail}`)
  }
  log.log(`created: ${record.createdAt}`)
  log.log(`updated: ${record.updatedAt}`)
  if (record.deletedAt) {
    log.log(`deleted: ${record.deletedAt}`)
  }
  log.log('')
  log.log(record.text)
}

function printGuidanceSummary(records: GuidanceRecord[]): void {
  if (records.length === 0) {
    log.log('no learned lessons yet - corrections become lessons automatically')
    return
  }
  for (const record of records) {
    const deleted = record.status === 'deleted' ? ' deleted' : ''
    log.log(
      `${record.id} [${record.scope.kind}${deleted}] ${record.stages.join(',')} - ${record.text}`
    )
  }
}

async function printLessonsList(
  ctx: WorkContext,
  opts: { includeDeleted?: boolean; scope?: 'global' | 'repo'; stage?: GuidanceStage }
): Promise<void> {
  printGuidanceSummary(await listGuidance(ctx, opts))
  log.log('')
  log.log('## Legacy LESSONS.md (read-only here; edit the file directly)')
  log.log((await readLessons(ctx)) ?? '(none yet)')
  log.log('')
  log.log('## Raw candidates (read-only here; edit the file directly)')
  log.log((await readCandidates(ctx)) ?? '(none yet)')
}

function parseGuidanceStage(value: string | undefined, usage: string): GuidanceStage {
  const parsed = GuidanceStageSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`${usage}\nvalid stages: ${GUIDANCE_STAGE_VALUES.join(', ')}`)
  }
  return parsed.data
}

function parseGuidanceScope(value: string | undefined, usage: string): 'global' | 'repo' {
  if (value === 'global' || value === 'repo') {
    return value
  }
  throw new Error(`${usage}\nvalid scopes: global, repo`)
}

function ambiguousGuidanceMessage(query: string, records: GuidanceRecord[]): string {
  return `ambiguous lesson id "${query}"\n  matches: ${records.map((record) => record.id).join(', ')}`
}

async function lessonsCommand(ctx: WorkContext, args: string[]): Promise<number> {
  const sub = args[0] && ['list', 'show', 'rm', 'edit'].includes(args[0]) ? args[0] : 'list'
  const rest = sub === 'list' && args[0] !== 'list' ? args : args.slice(1)

  try {
    if (sub === 'list') {
      const usage = 'usage: factory lessons list [--all] [--scope global|repo] [--stage <stage>]'
      let includeDeleted = false
      let scope: 'global' | 'repo' | undefined
      let stage: GuidanceStage | undefined
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i] ?? ''
        if (arg === '--all') {
          includeDeleted = true
        } else if (arg === '--scope') {
          scope = parseGuidanceScope(rest[i + 1], usage)
          i++
        } else if (arg.startsWith('--scope=')) {
          scope = parseGuidanceScope(arg.slice('--scope='.length), usage)
        } else if (arg === '--stage') {
          stage = parseGuidanceStage(rest[i + 1], usage)
          i++
        } else if (arg.startsWith('--stage=')) {
          stage = parseGuidanceStage(arg.slice('--stage='.length), usage)
        } else {
          throw new Error(usage)
        }
      }
      await printLessonsList(ctx, { includeDeleted, scope, stage })
      return 0
    }

    if (sub === 'show') {
      const id = rest[0]
      if (!id || rest.length !== 1) {
        log.fail('usage: factory lessons show <id>')
        return 1
      }
      const found = await findGuidance(ctx, id, { includeDeleted: true })
      if (!found) {
        log.fail(`no learned lesson matching "${id}"`)
        return 1
      }
      if ('ambiguous' in found) {
        log.fail(ambiguousGuidanceMessage(id, found.ambiguous))
        return 1
      }
      printGuidanceRecord(found.record)
      return 0
    }

    if (sub === 'rm') {
      const id = rest[0]
      if (!id || rest.length !== 1) {
        log.fail('usage: factory lessons rm <id>')
        return 1
      }
      const result = await deleteGuidance(ctx, id)
      if (!result) {
        log.fail(`no learned lesson matching "${id}"`)
        return 1
      }
      if ('ambiguous' in result) {
        log.fail(ambiguousGuidanceMessage(id, result.ambiguous))
        return 1
      }
      log.ok(`lessons -${result.deleted.id} (removed)`)
      return 0
    }

    const usage =
      'usage: factory lessons edit <id> [-m "<text>" | --message "<text>" | --scope global|repo | --stage <stage>... | --edit]'
    const id = rest[0]
    if (!id) {
      log.fail(usage)
      return 1
    }
    let message: string | null = null
    let edit = false
    let scope: 'global' | 'repo' | null = null
    const stages: GuidanceStage[] = []
    for (let i = 1; i < rest.length; i++) {
      const arg = rest[i] ?? ''
      if (arg === '-m' || arg === '--message') {
        const next = rest[i + 1]
        if (next === undefined) {
          throw new Error(usage)
        }
        message = next
        i++
      } else if (arg.startsWith('--message=')) {
        message = arg.slice('--message='.length)
      } else if (arg === '--edit') {
        edit = true
      } else if (arg === '--scope') {
        scope = parseGuidanceScope(rest[i + 1], usage)
        i++
      } else if (arg.startsWith('--scope=')) {
        scope = parseGuidanceScope(arg.slice('--scope='.length), usage)
      } else if (arg === '--stage') {
        stages.push(parseGuidanceStage(rest[i + 1], usage))
        i++
      } else if (arg.startsWith('--stage=')) {
        stages.push(parseGuidanceStage(arg.slice('--stage='.length), usage))
      } else {
        throw new Error(usage)
      }
    }
    const text =
      message !== null || edit ? await resolveMessage({ message, edit }, 'required') : null
    const patch = {
      text: text ?? undefined,
      stages: stages.length > 0 ? stages : undefined,
      scope: scope ? scopeForContext(ctx, scope) : undefined,
    }
    if (!patch.text && !patch.stages && !patch.scope) {
      log.fail(usage)
      return 1
    }
    const result = await editGuidance(ctx, id, patch)
    if (!result) {
      log.fail(`no learned lesson matching "${id}"`)
      return 1
    }
    if ('ambiguous' in result) {
      log.fail(ambiguousGuidanceMessage(id, result.ambiguous))
      return 1
    }
    log.ok(`lessons ${result.edited.id} (updated)`)
    return 0
  } catch (err) {
    log.fail(err instanceof Error ? err.message : String(err))
    return 1
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
      await setTaskDelivery(
        task,
        parseManualDelivery(value, await listDeliverySkills(ctx.root, ctx.repoStateDir))
      )
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

async function feedbackFacts(task: Task, hasWorktreeDiff: boolean, loopActive: boolean) {
  return feedbackRouteInput(task, await hasSavedPlan(task), hasWorktreeDiff, loopActive)
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

async function suggestTaskSlug(ctx: WorkContext, intent: string): Promise<string | null> {
  try {
    const result = await runAgent(ctx.agents.namer, {
      root: ctx.root,
      prompt: taskNamePrompt(intent),
      access: 'read',
    })
    return result.text
  } catch (err) {
    log.warn(
      `task name: ${agentLabel(ctx.agents.namer)} failed; using prompt prefix - ` +
        `${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }
}

async function queueNewTask(
  ctx: WorkContext,
  base: { intent: string; verify: string | null },
  options: ParsedAddOptions,
  existingFreshTaskIds: string[] = []
): Promise<void> {
  // factory add only enqueues a new task record when there is no current work; the
  // run loop sharpens non-trivial pending intents. --raw, a declared complexity, or
  // piped input all skip that sharpen pre-stage — and a declared complexity also
  // skips runtime triage.
  const skipSharpen = options.raw || options.complexity !== null || !process.stdin.isTTY
  const directed = extractDeliveryDirective(
    base.intent,
    await listDeliverySkills(ctx.root, ctx.repoStateDir)
  )
  // An explicit --name skips the namer model call: the spawner already named
  // this workstream and the worktree, so a second AI-chosen name is pure cost.
  const suggestedSlug = options.name ?? (await suggestTaskSlug(ctx, directed.intent))
  const task = await addTask(ctx, directed.intent, base.verify, {
    sharpen: skipSharpen ? 'skipped' : 'pending',
    complexity: options.complexity,
    delivery: directed.delivery ?? { mode: 'pending' },
    suggestedSlug,
  })
  const suffix = queuedSuffix({
    verify: base.verify,
    complexity: task.meta.complexity,
    sharpenPending: task.meta.sharpen === 'pending',
    delivery: task.meta.delivery,
  })
  log.ok(`queued ${task.id}${suffix}`)
  if (existingFreshTaskIds.length > 0) {
    const count = existingFreshTaskIds.length
    const plural = count === 1 ? '' : 's'
    log.warn(
      `this factory already has ${count} fresh queued task${plural}: ` +
        existingFreshTaskIds.join(', ')
    )
    log.info('one task per worktree keeps the workstream and commit provenance clean')
  }
}

// Idle-loop housekeeping for parked needs-input tasks. Two jobs:
//  1. AUTO-ACCEPT (opt-in via config.autoAcceptAfterMinutes): when every open
//     question carries a recommended answer and the task has waited past the
//     window, proceed with the recommendations — recorded as a normal answer so
//     it is visible, auditable, and overridable by later feedback. Real usage
//     showed rubber-stamp answers ("go with all recommendations") dominating
//     these waits, and hard-parked tasks losing races against manual work.
//  2. STALE SIGNAL: emit a `task.stale` hook once per parked task per loop run
//     after 24h, so the environment can nudge (the attention hook is deduped and
//     fires only on state changes).
const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const staleSignaled = new Set<string>()

async function tendParkedTasks(ctx: WorkContext): Promise<void> {
  const autoAcceptMs = ctx.config.autoAcceptAfterMinutes
    ? ctx.config.autoAcceptAfterMinutes * 60_000
    : null
  for (const task of await loadTasks(ctx)) {
    if (task.meta.status !== 'needs-input' && task.meta.status !== 'blocked') {
      continue
    }
    const parkedSince = Date.parse(task.meta.updatedAt ?? task.meta.createdAt)
    const waited = Date.now() - (Number.isFinite(parkedSince) ? parkedSince : Date.now())
    if (waited > STALE_AFTER_MS && !staleSignaled.has(task.id)) {
      staleSignaled.add(task.id)
      await emit(ctx.root, ctx.config.hooks, 'task.stale', {
        task: task.id,
        state: task.meta.status,
      })
      // One read-only moot check per parked task per loop run: parked intents
      // routinely land through other work (a hand-built feature, a re-spawned
      // worktree) while the original task rots. Detection only — closing is the
      // human's call via `factory close`.
      if (task.meta.status === 'needs-input') {
        try {
          const questions = (await readArtifact(task, 'questions.md')) ?? '(none recorded)'
          const intent = await Bun.file(`${task.dir}/task.md`).text()
          const out = await runAgent(ctx.agents.implementer, {
            root: ctx.root,
            prompt: mootCheckPrompt(intent.trim(), questions, task.meta.createdAt),
            access: 'read',
            outFile: `${task.dir}/moot.md`,
          })
          if (parseMoot(out.text) === true) {
            const summary = /SUMMARY:\s*(.+)/i.exec(out.text)?.[1]?.trim() ?? 'see moot.md'
            task.meta.note = `likely moot: ${summary} — close with: factory close ${task.id}`
            task.meta.updatedAt = new Date().toISOString()
            await saveMeta(task)
            await emit(ctx.root, ctx.config.hooks, 'attention', { state: 'needs-input' })
            log.warn(`${task.id}: likely MOOT — ${summary}`)
            log.info(`  close it with: factory close ${task.id} -m "already landed"`)
          }
        } catch (err) {
          log.warn(`moot check failed for ${task.id}: ${err instanceof Error ? err.message : err}`)
        }
      }
    }
    if (task.meta.status !== 'needs-input' || autoAcceptMs === null || waited < autoAcceptMs) {
      continue
    }
    const questionsText = await readArtifact(task, 'questions.md')
    if (!questionsText) {
      continue
    }
    const { questions } = parseFormattedQuestions(questionsText)
    if (questions.length === 0 || questions.some((q) => !q.rec)) {
      continue // only auto-accept when EVERY question has a recommendation
    }
    task.meta.autoAcceptedRounds += 1
    await answerTask(
      task,
      'Proceed with your recommended answers for all questions. ' +
        `(auto-accepted after ${Math.round(waited / 60_000)} minutes by ` +
        'config.autoAcceptAfterMinutes; treat each recommendation as an explicit ' +
        'assumption and record it in the spec)',
      { repoStateDir: ctx.repoStateDir, verdict: 'auto-accept' }
    )
    log.warn(`${task.id}: auto-accepted recommended answers after ${Math.round(waited / 60_000)}m`)
  }
}

async function spawnViaCommand(
  ctx: RepoContext,
  entry: BacklogEntry,
  spawn: string
): Promise<boolean> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  env['FACTORY_INTENT'] = entry.intent
  env['FACTORY_NAME'] = entry.id
  env['FACTORY_VERIFY'] = entry.verify ?? ''
  const res = await run(['bash', '-lc', spawn], { cwd: ctx.mainRoot, stdin: '', env })
  if (res.code !== 0) {
    log.fail(
      `spawn failed for ${entry.id} (exit ${res.code}): ${(res.stderr || res.stdout).slice(0, 300)}`
    )
    return false
  }
  return true
}

// The zero-config spawner: sibling worktree on a factory/<name> branch, task
// queued with the backlog's name/intent/verify, and a detached
// `factory run --until-done` whose output goes to $FACTORY_HOME/logs/<name>.log.
// No tmux, no custom layout — configure dispatch.spawn to route through your own
// tooling when you want those.
async function spawnBuiltin(ctx: RepoContext, entry: BacklogEntry): Promise<boolean> {
  const dir = `${ctx.mainRoot}-${entry.id}`
  const branch = `factory/${entry.id}`
  const wt = await run(['git', '-C', ctx.mainRoot, 'worktree', 'add', '-b', branch, dir], {
    cwd: ctx.mainRoot,
    stdin: '',
  })
  if (wt.code !== 0) {
    log.fail(`worktree add failed for ${entry.id}: ${(wt.stderr || wt.stdout).slice(0, 300)}`)
    return false
  }
  const invoke = factoryInvocation()
  const addArgs = ['add', '--name', entry.id, entry.intent]
  if (entry.verify) {
    addArgs.push('--verify', entry.verify)
  }
  const added = await run([...invoke, ...addArgs], { cwd: dir, stdin: '' })
  if (added.code !== 0) {
    log.fail(`factory add failed for ${entry.id}: ${(added.stderr || added.stdout).slice(0, 300)}`)
    return false
  }
  await mkdir(dispatchLogsDir(), { recursive: true })
  const logFile = `${dispatchLogsDir()}/${entry.id}.log`
  const quoted = invoke.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(' ')
  const detach = await run(
    ['bash', '-lc', `nohup ${quoted} run --until-done --no-prompt >> '${logFile}' 2>&1 & disown`],
    { cwd: dir, stdin: '' }
  )
  if (detach.code !== 0) {
    log.fail(`could not start the run loop for ${entry.id}`)
    return false
  }
  log.info(`  worktree ${dir} · branch ${branch} · log ${logFile}`)
  return true
}

async function repoRootOrNull(cwd: string): Promise<string | null> {
  try {
    return await repoRoot(cwd)
  } catch {
    return null
  }
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
    const routeTasks = await addRouteTasks(tasks)
    const route = selectAddRoute(
      routeTasks,
      await hasChanges(ctx.root),
      (await runLockHolder(ctx.stateDir)) !== null
    )
    if (route.kind === 'new-task') {
      const existingFreshTaskIds = routeTasks
        .filter(
          (task) =>
            task.status === 'ready' && !task.hasPlan && !task.hasCommit && !task.pendingFeedback
        )
        .map((task) => task.id)
      if (existingFreshTaskIds.length > 0 && !parsed.options.forceNew) {
        // One active task per workstream, enforced. A second fresh task belongs
        // in its own worktree; deliberate batching needs the explicit flag.
        log.fail(
          `this workstream already has a fresh queued task: ${existingFreshTaskIds.join(', ')}`
        )
        log.info('start it in a new worktree, or pass --force-new to batch deliberately')
        return 1
      }
      await queueNewTask(ctx, base, parsed.options, existingFreshTaskIds)
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
      await answerTask(task, base.intent, { repoStateDir: ctx.repoStateDir })
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
    if (route.kind === 'feedback-live') {
      // A live loop owns this task's status; record the feedback only. It is
      // consumed after the in-flight pass commits, or by the next pass.
      await appendFeedback(task, base.intent)
      log.ok(`${task.id}: feedback recorded — ${route.reason}`)
      return 0
    }
    if (route.recordOnSource) {
      await appendFeedback(task, base.intent)
      markFeedbackConsumed(task, task.meta.feedbackCount)
      await saveMeta(task)
    }
    const followUpText = followUpIntent(task, base.intent)
    const followUp = await addTask(ctx, followUpText, task.meta.verify, {
      sharpen: 'skipped',
      feedbackSourceTaskId: task.id,
      suggestedSlug: await suggestTaskSlug(ctx, followUpText),
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
    const untilDone = rest.includes('--until-done')
    const ctx = await loadContext(process.cwd())
    log.info(
      once
        ? 'running one task'
        : drain
          ? 'draining queue'
          : untilDone
            ? 'running until the workstream task completes'
            : 'watching queue (Ctrl-C to stop)'
    )

    // One loop per worktree, enforced: a second concurrent loop would reclaim
    // the first loop's in-flight task as "stranded". Released on exit/SIGINT.
    let releaseLock: (() => Promise<void>) | null = null
    try {
      releaseLock = await acquireRunLock(ctx.stateDir)
    } catch (err) {
      if (err instanceof RunLockError) {
        log.fail(err.message)
        return 1
      }
      throw err
    }
    const release = async () => {
      if (releaseLock) {
        const r = releaseLock
        releaseLock = null
        await r()
      }
    }
    process.on('SIGINT', () => {
      void release().finally(() => process.exit(130))
    })
    process.on('SIGTERM', () => {
      void release().finally(() => process.exit(143))
    })

    // In the long-lived watch mode, when someone is at the terminal, prompt for
    // needs-input answers inline. Bounded runs (--once/--drain) and non-TTY/piped
    // runs keep the set-aside + state-aware `factory add` behavior; opt out with
    // --no-prompt.
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
        try {
          await tendParkedTasks(ctx)
        } catch (err) {
          log.warn(`parked-task housekeeping failed: ${err instanceof Error ? err.message : err}`)
        }
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
        if (untilDone) {
          // Spawner contract: the workstream's task completed — exit 0 so the
          // surrounding tooling (tmux window, worktree teardown) can proceed.
          await emit(ctx.root, ctx.config.hooks, 'stage.change', { stage: '', active: false })
          await release()
          return 0
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
        if (untilDone) {
          // Spawner contract: blocked means a human decision is required — exit
          // nonzero so teardown does NOT proceed and the workstream stays up.
          await emit(ctx.root, ctx.config.hooks, 'stage.change', { stage: '', active: false })
          await release()
          return 2
        }
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
    await release()
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
    await answerTask(task, text, { repoStateDir: ctx.repoStateDir })
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
    const loopActive = (await runLockHolder(ctx.stateDir)) !== null
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
        feedbackRouteInput(
          candidate,
          hasPlanByTask.get(candidate.id) ?? false,
          hasWorktreeDiff,
          loopActive
        )
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
    const route = decideFeedbackRoute(await feedbackFacts(task, hasWorktreeDiff, loopActive))
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
      const followUpText = followUpIntent(task, text)
      const followUp = await addTask(ctx, followUpText, task.meta.verify, {
        sharpen: 'skipped',
        feedbackSourceTaskId: task.id,
        suggestedSlug: await suggestTaskSlug(ctx, followUpText),
      })
      log.ok(`${task.id}: done — queued follow-up ${followUp.id} for feedback`)
      return 0
    }

    if (route.kind === 'record') {
      // A live loop owns this task's status; append only, no requeue.
      await appendFeedback(task, text)
      log.ok(`${task.id}: feedback recorded — the running loop will consume it`)
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

  if (cmd === 'evals') {
    // The replay runner: re-run harvested eval candidates against the CURRENT
    // factory build and score them. This is the regression gate for changes to
    // prompts, policies, and factory itself.
    const sub = rest[0] ?? 'list'
    const ctx = await loadContext(process.cwd())
    const repoCtx = await loadRepoContext(process.cwd())
    const cases = await listEvalCases(ctx.repoStateDir)
    if (sub === 'list') {
      if (cases.length === 0) {
        log.info('no eval candidates captured for this repo yet')
        return 0
      }
      for (const c of cases) {
        log.log(`${c.file} · ${c.case.outcome} · base ${c.case.baseCommit.slice(0, 10)}`)
      }
      log.info(`${cases.length} candidates · run one: factory evals run <file-substring>`)
      return 0
    }
    if (sub === 'run') {
      const keep = rest.includes('--keep')
      const filter = rest.slice(1).find((a) => !a.startsWith('--'))
      const selected = filter ? cases.filter((c) => c.file.includes(filter)) : cases
      const runnable = selected.filter((c) => c.case.outcome !== 'corrected')
      if (runnable.length === 0) {
        log.fail(filter ? `no replayable case matching ${filter}` : 'no replayable cases')
        return 1
      }
      log.info(
        `replaying ${runnable.length} case${runnable.length === 1 ? '' : 's'} against the ` +
          'current factory build — each is a full pipeline run'
      )
      let matched = 0
      for (const c of runnable) {
        log.step(`replaying ${c.file}`)
        const result = await runEvalCase(repoCtx.mainRoot, c, { keep })
        await appendEvalResult(ctx.repoStateDir, result)
        if (result.error) {
          log.fail(`${c.file}: ${result.error}`)
          continue
        }
        const verdict = result.outcomeMatch ? 'outcome-match' : 'OUTCOME-MISMATCH'
        if (result.outcomeMatch) {
          matched++
        }
        log.ok(
          `${c.file}: ${verdict} (expected ${result.expectedOutcome}, replay ${result.replayStatus}) · ` +
            `file overlap ${(result.fileJaccard * 100).toFixed(0)}% · ${Math.round(result.durationMs / 1000)}s`
        )
      }
      log.info(
        `replay summary: ${matched}/${runnable.length} outcome matches · results: ` +
          `${ctx.repoStateDir}/eval-results.jsonl`
      )
      return matched === runnable.length ? 0 : 1
    }
    log.fail('usage: factory evals [list | run [case-substring] [--keep]]')
    return 1
  }

  if (cmd === 'dispatch') {
    // Drain the repo backlog by spawning one workstream per item through the
    // configured spawn command (one task = one worktree = one lifecycle, owned
    // by the spawner tool). Factory hands the item over; it does not queue
    // tasks internally or manage lanes.
    const ctx = await loadRepoContext(process.cwd())
    const spawn = ctx.config.dispatch?.spawn ?? null
    const dryRun = rest.includes('--dry-run')
    const limitIdx = rest.indexOf('--limit')
    const limit = limitIdx !== -1 ? Number(rest[limitIdx + 1]) : Number.POSITIVE_INFINITY
    if (Number.isNaN(limit) || limit <= 0) {
      log.fail('--limit needs a positive number')
      return 1
    }
    const entries = await loadBacklog(ctx)
    if (entries.length === 0) {
      log.info('backlog is empty')
      return 0
    }
    let spawned = 0
    for (const entry of entries) {
      if (spawned >= limit) {
        break
      }
      if (dryRun) {
        log.info(`would dispatch ${entry.id}: ${entry.intent.split('\n')[0]}`)
        spawned++
        continue
      }
      log.step(`dispatching ${entry.id}`)
      const ok = spawn ? await spawnViaCommand(ctx, entry, spawn) : await spawnBuiltin(ctx, entry)
      if (!ok) {
        log.info('stopping dispatch; the item stays in the backlog')
        return 1
      }
      await removeBacklog(ctx, entry.id)
      log.ok(`dispatched ${entry.id}`)
      spawned++
    }
    log.info(
      `${dryRun ? 'would dispatch' : 'dispatched'} ${spawned} item${spawned === 1 ? '' : 's'}`
    )
    return 0
  }

  if (cmd === 'harvest') {
    // Post-ship feedback harvesting: human rework and MR discussion on shipped
    // tasks. --all re-checks previously harvested tasks too.
    const ctx = await loadContext(process.cwd())
    const all = rest.includes('--all')
    const query = rest.find((a) => !a.startsWith('--'))
    const tasks = await loadTasks(ctx)
    const targets = query
      ? tasks.filter((t) => t.id.includes(query))
      : tasks.filter((t) => t.meta.status === 'done' && (all || !t.meta.harvestedAt))
    if (targets.length === 0) {
      log.info(
        query ? `no task matching ${query}` : 'no unharvested done tasks (use --all to re-check)'
      )
      return 0
    }
    let reworked = 0
    for (const task of targets) {
      const result = await harvestTask(ctx, task)
      logHarvest(result)
      if (result.reworkCommits.length > 0) {
        reworked++
      }
    }
    log.info(
      `harvested ${targets.length} task${targets.length === 1 ? '' : 's'} · ${reworked} with human rework`
    )
    return 0
  }

  if (cmd === 'close') {
    // Terminal close without a commit: the task is abandoned or superseded
    // (typically flagged moot — the intent already landed through other work).
    const usage = 'usage: factory close [task-id] [-m <reason> | --edit]'
    const ctx = await loadContext(process.cwd())
    const parsed = parseInputArgs(rest, usage)
    if (!parsed.ok) {
      log.fail(parsed.error)
      return 1
    }
    const task = parsed.taskQuery
      ? await findTask(ctx, parsed.taskQuery)
      : await latestTask(ctx, ['needs-input', 'blocked', 'retrying'])
    if (!task) {
      log.fail(
        parsed.taskQuery ? `no task matching ${parsed.taskQuery}` : 'no parked task to close'
      )
      return 1
    }
    if (task.meta.status === 'done' || task.meta.status === 'closed') {
      log.fail(`${task.id} is already ${task.meta.status}`)
      return 1
    }
    const reason = (await resolveMessage(parsed, 'optional')) || 'closed by the human'
    await setStatus(task, 'closed', reason)
    log.ok(`${task.id}: closed — ${reason}`)
    return 0
  }

  if (cmd === 'gc') {
    // Worktrees are ephemeral in the workstream model (spawned per task, torn
    // down on done); their session state is debris once the worktree is gone.
    // Durable value (metrics, lessons, evals, delivery history) lives at the
    // repo level and is never touched here.
    const dryRun = rest.includes('--dry-run')
    const base = sessionsDir()
    let entries: string[] = []
    try {
      entries = (await readdir(base, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      log.info('no session state to collect')
      return 0
    }
    const currentRoot = await repoRootOrNull(process.cwd())
    let removed = 0
    let kept = 0
    let unknown = 0
    for (const name of entries) {
      const dir = `${base}/${name}`
      let root: string | null = null
      try {
        const marker = await Bun.file(worktreeMarkerPath(dir)).json()
        root = z.object({ root: z.string() }).parse(marker).root
      } catch {
        unknown++
        continue // no marker → can't prove the worktree is gone; leave it
      }
      if (root === currentRoot) {
        kept++
        continue
      }
      const worktreeExists = await stat(root).then(
        (s) => s.isDirectory(),
        () => false
      )
      if (worktreeExists) {
        kept++
        continue
      }
      if (dryRun) {
        log.info(`would remove ${dir} (worktree gone: ${root})`)
      } else {
        await rm(dir, { recursive: true, force: true })
        log.ok(`removed ${dir} (worktree gone: ${root})`)
      }
      removed++
    }
    log.info(
      `${dryRun ? 'would remove' : 'removed'} ${removed} · kept ${kept} live` +
        (unknown ? ` · ${unknown} unidentifiable (no worktree marker; left alone)` : '')
    )
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
      if (rest.includes('--repo')) {
        const repoPath = await repoConfigFile(ctx.root)
        if (!repoPath) {
          log.fail('not in a git repo — the --repo config layer is keyed by repo identity')
          return 1
        }
        await mkdir(dirname(repoPath), { recursive: true })
        if (!(await Bun.file(repoPath).exists())) {
          await Bun.write(repoPath, '{}\n')
        }
        log.info(`editing ${repoPath} (repo layer: all worktrees of this repo, this machine)`)
        await openEditor(repoPath)
        return 0
      }
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

  if (cmd === 'skills') {
    const ctx = await loadContext(process.cwd())
    const sub = rest[0] ?? 'list'
    const repoLayerDir = `${ctx.repoStateDir}/skills`
    if (sub === 'list') {
      const effective = await listDeliverySkills(ctx.root, ctx.repoStateDir)
      if (effective.length === 0) {
        log.info('no delivery skills registered')
      }
      for (const skill of effective) {
        log.log(`${skill.name} — ${skill.description ?? '(no description)'}`)
      }
      log.info(
        `layers (most specific wins): ${ctx.root}/.skills → ${repoLayerDir} → ${globalSkillsDir()}`
      )
      log.info('edit: factory skills edit <name> [--repo|--global|--committed]')
      return 0
    }
    if (sub === 'edit') {
      const name = rest[1]
      if (!name || name.startsWith('--')) {
        log.fail('usage: factory skills edit <name> [--repo|--global|--committed]')
        return 1
      }
      const layer = rest.includes('--global')
        ? globalSkillsDir()
        : rest.includes('--committed')
          ? `${ctx.root}/.skills`
          : repoLayerDir
      const path = `${layer}/${name}/SKILL.md`
      await mkdir(dirname(path), { recursive: true })
      if (!(await Bun.file(path).exists())) {
        await Bun.write(
          path,
          `---\nname: ${name}\ndescription: <one line the delivery selector reads>\n---\n\nInstructions the delivery agent follows to run \`$${name}\`.\n`
        )
      }
      log.info(`editing ${path}`)
      await openEditor(path)
      return 0
    }
    log.fail('usage: factory skills [list | edit <name> [--repo|--global|--committed]]')
    return 1
  }

  if (cmd === 'show') {
    const ctx = await loadContext(process.cwd())
    return printShow(ctx, rest[0], rest[1])
  }

  if (cmd === 'lessons') {
    const ctx = await loadContext(process.cwd())
    return lessonsCommand(ctx, rest)
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
