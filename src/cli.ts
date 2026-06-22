#!/usr/bin/env bun
import { dirname } from 'node:path'
import { type ParsedAddOptions, parseAddOptions } from './add-options.ts'
import { askFactory } from './ask.ts'
import { addBacklog, loadBacklog, removeBacklog } from './backlog.ts'
import { AUTO_CAP, runTask, type TaskOutcome } from './conductor.ts'
import {
  type Agent,
  ConfigError,
  globalConfigFile,
  loadContext,
  loadRepoContext,
  type WorkContext,
} from './config.ts'
import { composeInEditor, openEditor } from './editor.ts'
import { captureCorrection, captureEvalCase } from './evals.ts'
import { NotARepoError } from './git.ts'
import { emit, type Hooks } from './hooks.ts'
import { readCandidates, readLessons } from './lessons.ts'
import { log } from './log.ts'
import { sharpen } from './sharpen.ts'
import {
  addTask,
  appendAnswer,
  findTask,
  latestTask,
  loadTasks,
  nextRunnable,
  RESUMABLE_STATUSES,
  setStatus,
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
      Add a task to this worktree's queue. This ONLY queues — it does not start
      working. A running 'factory run' (below) is what actually picks tasks up.
      With no intent (or --edit), opens $EDITOR to compose it — handy when a fresh
      worktree opens and you want to write the first task before walking away. The
      intent can also be piped on stdin (multi-line specs). --verify is the command
      that proves the task works; it's run for real before commit.
      By default the running loop triages the task, then SHARPENS non-trivial
      pending intents before planning: an agent refines them into self-contained
      specs, reading the repo itself and pausing with questions.md only when it
      needs a human decision. --raw skips sharpening and queues the intent as-is;
      runtime triage still decides complexity. Auto-skipped when the intent is
      piped. --trivial / --complexity skip sharpening too and use the declared
      runtime complexity instead of triage.

  factory run [--once | --drain]
      Work the queue. Default: stay running and pick up tasks as they're added
      (factory add), unblocked (factory resume/answer), due for an auto-retry, or
      stranded mid-stage by a previously killed loop (Ctrl-C/crash) — shovel coal
      into the engine. So restarting after a Ctrl-C just resumes the interrupted
      task. A transient gate failure (verify/ship) is set aside and AUTO-RESUMED on
      a backoff (up to a cap) before it truly blocks, so env/CI flakes recover with
      no action from you.
        --once    do one ready task, then exit (good for trying it out)
        --drain   work until the queue is empty, then exit

  factory answer [task-id] <answer...>
      When a task is too ambiguous to build safely, the loop PAUSES it (status
      'needs-input') and writes the questions it needs you to settle — you'll see
      them in 'factory status' and 'factory show <id>'. This command replies to those
      questions and puts the task back in the queue; your answer is folded into the
      next sharpen or planning pass. Omit the id to answer the latest needs-input task.

  factory resume [task-id] [note...]
      Pick a BLOCKED, waiting-to-retry, or interrupted (killed mid-stage) task back
      up where it left off — it reuses the saved plan and the code already in the
      worktree and re-enters at the stage that failed, instead of re-planning from
      scratch. Omit the id for the latest such task; add an optional note as
      fix-context for the retry. Use this for review-panel blocks (after you've
      looked) or to force a transient retry now. (Note: a running 'factory run'
      already auto-reclaims interrupted tasks; this is the manual equivalent.)
      (Contrast 'answer', which re-plans; 'resume' continues.)

  factory correct [task-id] [note...]
      When you take over a BLOCKED task and fix it yourself, record the lesson: it
      pairs the agent's failed attempt with your in-worktree fix, distills what it
      should have done (sharpened by your note), saves a lesson + eval case, and
      marks the task done. Run it with your fix in the worktree, before committing.
      Omit the id for the latest blocked task. (The highest-signal way the factory
      learns — your corrections are the answer key.)

  factory status              Catch-up dashboard: what's running (and for how long),
                           what's waiting on you, what's blocked, what's done.
  factory ask [task-id] <question...>
                           Ask the configured AI about saved factory task state.
  factory show [task-id] [step]  Drill into one task (defaults to the latest here);
                             with a step (e.g. implement, review, plan.codex), show
                             that step's line-by-line agent activity. A lone step
                             name applies to the latest task (factory show review).
  factory report              Telemetry across all the repo's tasks: first-pass yield,
                           escalation/blocked rate, cost, where the tokens go.
  factory lessons             Curated lessons (LESSONS.md) + raw candidates.
  factory config [edit [--global|--worktree|--repo-parent|--dir <dir>]]
                           Show effective config + where it's set; edit opens the
                           global config by default; flags target another layer.
  factory version | --version    Print the current CLI version.
  factory upgrade                Update factory to the latest GitHub release.

HOW A TASK FLOWS
  ready → plan (codex + claude) → cross-critique → reconcile
        → [pause & ask you, if ambiguous] → implement → review → verify
        → commit → [ship, if configured]
  A failed gate auto-fixes and retries (config.retries) in-run before escalating.
  A transient verify/ship failure is then auto-resumed on a backoff; a review or
  review-panel block (or an exhausted retry budget) escalates: it shows in 'factory
  status' and emits the attention hook once the loop has nothing else runnable.
  The hook consumer decides whether that means a tmux color, bell, notification, or
  something else. Reply to a
  question with 'factory answer'; pick a block back up with 'factory resume'.

TYPICAL USE
  Try one task end to end (queue, then process it):
      factory add "Add retry to the upload client" --verify "bun test upload"
      factory run --once

  Run a continuous loop and feed it (the usual fleet mode):
      factory run                    # in a worktree; leave it running, then walk away
      factory add "Another task..."  # from anywhere; the running loop picks it up
      factory ask "has ship ran?"    # ask from the saved task state
      factory answer "..."           # only if a task pauses to ask
      factory resume                 # pick a blocked task back up where it left off

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
  onComplete  deliver each done task via a full-permission agent. {"skill":
            "name"} runs a skill; {"policy":"text"} follows a policy (open MR/PR,
            iterate CI, reply to review). null (default) = don't ship.
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

// The queue's most-important state for attention and the idle label:
// blocked > needs-input > all-done > nothing.
async function queueState(ctx: WorkContext): Promise<AlertState | null> {
  const tasks = await loadTasks(ctx)
  const has = (s: string) => tasks.some((t) => t.meta.status === s)
  const allDone = tasks.length > 0 && tasks.every((t) => t.meta.status === 'done')
  return has('blocked') ? 'blocked' : has('needs-input') ? 'needs-input' : allDone ? 'done' : null
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    log.log(HELP)
    return 0
  }

  if (cmd === 'version' || cmd === '--version') {
    log.log(FACTORY_VERSION)
    return 0
  }

  if (cmd === 'upgrade') {
    return await upgradeFactory()
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
    // factory add only enqueues; the run loop sharpens non-trivial pending intents.
    // --raw, a declared complexity, or piped input all skip that sharpen pre-stage —
    // and a declared complexity also skips runtime triage.
    const skipSharpen =
      parsed.options.raw || parsed.options.complexity !== null || !process.stdin.isTTY
    const task = await addTask(ctx, base.intent, base.verify, {
      sharpen: skipSharpen ? 'skipped' : 'pending',
      complexity: parsed.options.complexity,
    })
    const suffix = queuedSuffix({
      verify: base.verify,
      complexity: task.meta.complexity,
      sharpenPending: task.meta.sharpen === 'pending',
    })
    log.ok(`queued ${task.id}${suffix}`)
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
    // later (factory add), unblocked later (factory resume/answer), or due for an
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
      } else if (outcome.kind === 'needs-input') {
        await setStatus(task, 'needs-input', 'awaiting answer — see questions.md')
        await emit(ctx.root, ctx.config.hooks, 'task.needs_input', { task: task.id })
        log.warn(`${task.id}: needs input — run: factory answer "..."`)
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
        log.warn(
          `${task.id}: ${outcome.reason} — auto-retry ${outcome.autoRetries}/${AUTO_CAP} at ${new Date(outcome.retryAt).toLocaleTimeString()}`
        )
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
        log.info(`    detail: factory show ${task.id}  ·  retry: factory resume`)
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
    const ctx = await loadContext(process.cwd())
    // id optional: a first arg that matches a task is the id; otherwise the whole
    // rest is the answer for the latest needs-input task (factory answer "...").
    const [first, ...textParts] = rest
    let task = first ? await findTask(ctx, first) : await latestTask(ctx, ['needs-input'])
    let text = textParts
    if (first && !task) {
      task = await latestTask(ctx, ['needs-input'])
      text = rest
    }
    if (!task) {
      log.fail('no needs-input task to answer')
      return 1
    }
    if (text.length === 0) {
      log.fail('usage: factory answer [task-id] <answer...>')
      return 1
    }
    await appendAnswer(task, text.join(' '))
    await setStatus(task, 'ready')
    log.ok(`${task.id}: answered, back in queue`)
    return 0
  }

  if (cmd === 'resume') {
    const ctx = await loadContext(process.cwd())
    // Pick up a stuck task where it left off — reuse its plan + diff, no re-plan.
    // id optional (defaults to the latest blocked/retrying task, or one stranded
    // mid-stage by a killed loop); a first arg that isn't a task is taken as the
    // (optional) note for that latest task.
    const [first, ...noteParts] = rest
    let task = first ? await findTask(ctx, first) : await latestTask(ctx, RESUMABLE_STATUSES)
    let note = noteParts
    if (first && !task) {
      task = await latestTask(ctx, RESUMABLE_STATUSES)
      note = rest
    }
    if (!task) {
      log.fail('no resumable task (blocked, retrying, or interrupted mid-stage)')
      return 1
    }
    task.meta.resume = true
    task.meta.resumeNote = note.length > 0 ? note.join(' ') : null
    task.meta.resumeKind = 'manual'
    // Manual resume restores the full auto-retry budget for transient failures.
    task.meta.autoRetries = 0
    task.meta.retryAt = null
    await setStatus(task, 'ready')
    log.ok(`${task.id}: resuming — back in queue${note.length > 0 ? ' with note' : ''}`)
    return 0
  }

  if (cmd === 'correct') {
    const ctx = await loadContext(process.cwd())
    // Record a manual takeover of a blocked task: pair the agent's attempt with your
    // in-worktree fix into a lesson + eval case, then mark it done. id optional
    // (latest blocked); a first arg that isn't a task is taken as the note.
    const [first, ...noteParts] = rest
    let task = first ? await findTask(ctx, first) : await latestTask(ctx, ['blocked'])
    let note = noteParts
    if (first && !task) {
      task = await latestTask(ctx, ['blocked'])
      note = rest
    }
    if (!task) {
      log.fail('no blocked task to correct')
      return 1
    }
    await captureCorrection(ctx, task, note.join(' '))
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

  if (cmd === 'config') {
    const ctx = await loadContext(process.cwd())
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
    const ctx = await loadRepoContext(process.cwd())
    printReport(ctx)
    return 0
  }

  log.fail(`unknown command: ${cmd}`)
  log.log(HELP)
  return 1
}

// A bad config or running outside a repo is user error, not a crash: print it
// cleanly and exit. Anything else is an unexpected bug — let it throw so the
// stack trace is preserved.
try {
  process.exit(await main())
} catch (err) {
  if (err instanceof ConfigError || err instanceof NotARepoError) {
    log.fail(err.message)
    process.exit(1)
  }
  throw err
}
