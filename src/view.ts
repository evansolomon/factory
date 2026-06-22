import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { agentLabel } from './agents.ts'
import { configSources, globalConfigFile, type RepoContext, type WorkContext } from './config.ts'
import { currentBranch } from './git.ts'
import { log } from './log.ts'
import { type Report, readReport } from './metrics.ts'
import { findTask, latestTask, loadTasks, type Task } from './task.ts'

// Show the effective (merged) config for this worktree and which files set it,
// so the cascade is legible — and you know exactly where to edit.
export async function printConfig(ctx: WorkContext): Promise<void> {
  const c = ctx.config
  const field = (name: string, val: string) => log.log(`  ${name.padEnd(11)} ${val}`)
  const oc = c.onComplete
  const ocLabel = !oc
    ? '(not set — committed, not shipped)'
    : 'skill' in oc
      ? `skill: ${oc.skill}`
      : `policy: ${oc.policy}`
  const a = ctx.agents

  log.log(`factory config — effective for ${ctx.root}`)
  log.log('')
  field('dir', c.dir ?? '(unset → ~/.factory/sessions or $FACTORY_HOME/sessions)')
  field('stateDir', ctx.stateDir)
  field('retries', String(c.retries))
  field('triage', String(c.triage))
  field('security', String(c.security))
  field('ux', String(c.ux))
  field('plansDir', c.plansDir ?? '(disabled)')
  field('captureEvals', String(c.captureEvals))
  field('postmortem', String(c.postmortem))
  field('onComplete', ocLabel)
  field('ask', agentLabel(ctx.askAgent))
  log.log('')
  field('planners', a.planners.map(agentLabel).join(', '))
  field('implementer', agentLabel(a.implementer))
  field('reviewer', agentLabel(a.reviewer))
  field('delivery', agentLabel(a.delivery))
  const hookEvents = Object.entries(c.hooks)
  if (hookEvents.length > 0) {
    log.log('')
    log.log('  hooks:')
    for (const [event, commands] of hookEvents) {
      for (const command of commands) {
        log.log(`    ${event.padEnd(16)} ${command}`)
      }
    }
  }
  log.log('')
  field('state →', ctx.stateDir)
  if (ctx.plansDir) {
    field('plans →', ctx.plansDir)
  }
  log.log('')
  const sources = await configSources(ctx.root)
  if (sources.length > 0) {
    log.log('  set by (closest wins):')
    for (const s of sources) {
      log.log(`    ${s}`)
    }
    log.log('')
  }

  const parent = dirname(ctx.root)
  const global = globalConfigFile()
  log.log('  to edit (.factory.json cascades up; closest wins):')
  log.log(`    global defaults:            ${global}   ← factory config edit`)
  log.log(
    `    just this worktree:          ${ctx.root}/.factory.json   (factory config edit --worktree)`
  )
  log.log(
    `    all worktrees of this repo:  ${parent}/.factory.json   (factory config edit --repo-parent)`
  )
  log.log('    custom layer:                factory config edit --dir <dir>')
}

// Settled/waiting statuses; anything else (planning…verifying, shipping,
// sharpening) is a task actively being worked, so new stages show without a list.
const SETTLED = new Set(['ready', 'needs-input', 'blocked', 'retrying', 'done'])

// Compact "time until" a future ISO instant, for the auto-retry countdown.
function until(iso: string): string {
  const seconds = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  return `${Math.floor(minutes / 60)}h`
}

function age(iso: string | null): string {
  if (!iso) {
    return '?'
  }
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

async function fileText(task: Task, name: string): Promise<string | null> {
  const file = Bun.file(`${task.dir}/${name}`)
  return (await file.exists()) ? (await file.text()).trim() : null
}

async function firstQuestion(task: Task): Promise<string> {
  const text = await fileText(task, 'questions.md')
  if (!text) {
    return ''
  }
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^DECISION:/i.test(l))
  return (line ?? '').replace(/^[-*]\s*/, '')
}

// The catch-up dashboard: everything happening in this worktree, derived purely
// from durable state (meta + questions files), so it's accurate no matter how
// much scrollback you missed.
export async function printStatus(ctx: WorkContext): Promise<void> {
  const tasks = await loadTasks(ctx)
  const branch = await currentBranch(ctx.root)
  log.log(`factory — ${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${branch}`)

  if (tasks.length === 0) {
    log.info('no tasks — queue one with: factory add "…"')
    return
  }

  const inProgress = tasks.filter((t) => !SETTLED.has(t.meta.status))
  const needsInput = tasks.filter((t) => t.meta.status === 'needs-input')
  const retrying = tasks.filter((t) => t.meta.status === 'retrying')
  const blocked = tasks.filter((t) => t.meta.status === 'blocked')
  const done = tasks.filter((t) => t.meta.status === 'done')
  const ready = tasks.filter((t) => t.meta.status === 'ready')

  for (const t of inProgress) {
    log.log('')
    log.log(`▶ now:   ${t.id} — ${t.meta.status} (${age(t.meta.updatedAt)} in stage)`)
  }

  if (needsInput.length > 0) {
    log.log('')
    log.log(`⚠ awaiting you (${needsInput.length}):`)
    for (const t of needsInput) {
      const q = await firstQuestion(t)
      log.log(`   ${t.id}${q ? ` — ${q}` : ''}`)
      log.log(`        → factory answer ${t.id} "…"`)
    }
  }

  if (retrying.length > 0) {
    log.log('')
    log.log(`↻ retrying (${retrying.length}):`)
    for (const t of retrying) {
      const when = t.meta.retryAt ? `auto-retry in ${until(t.meta.retryAt)}` : 'auto-retry pending'
      log.log(`   ${t.id}${t.meta.note ? ` — ${t.meta.note}` : ''}  (${when})`)
    }
  }

  if (blocked.length > 0) {
    log.log('')
    log.log(`✗ blocked (${blocked.length}):`)
    for (const t of blocked) {
      log.log(`   ${t.id}${t.meta.note ? ` — ${t.meta.note}` : ''}   → factory resume`)
    }
  }

  if (done.length > 0) {
    log.log('')
    log.log(`✓ done (${done.length}):  ${done.map((t) => t.id).join('  ')}`)
  }
  if (ready.length > 0) {
    log.log(`· ready (${ready.length}): ${ready.map((t) => t.id).join('  ')}`)
  }
}

// One teed agent event (codex --json or claude stream-json). Loose on purpose —
// only the fields we render are declared; everything else is ignored.
const ActivityEvent = z.object({
  type: z.string().default(''),
  item: z
    .object({
      type: z.string().default(''),
      text: z.string().optional(),
      command: z.string().optional(),
    })
    .optional(),
  message: z
    .object({
      content: z
        .array(
          z.object({
            type: z.string().default(''),
            text: z.string().optional(),
            name: z.string().optional(),
          })
        )
        .optional(),
    })
    .optional(),
})

// Step names with a persisted activity log in the task dir.
async function activitySteps(task: Task): Promise<string[]> {
  try {
    return (await readdir(task.dir))
      .filter((f) => f.endsWith('.activity.jsonl'))
      .map((f) => f.replace(/\.activity\.jsonl$/, ''))
      .sort()
  } catch {
    return []
  }
}

// Render one step's teed agent activity as a readable timeline (agent text +
// `→ tool/command`); skips noise and degrades to nothing for events it can't read.
async function showActivity(task: Task, step: string): Promise<number> {
  const steps = await activitySteps(task)
  const match = steps.includes(step) ? step : steps.find((s) => s.startsWith(step))
  if (!match) {
    log.fail(`no activity for step "${step}"`)
    if (steps.length > 0) {
      log.info(`  available: ${steps.join(', ')}`)
    }
    return 1
  }
  const jsonl = await fileText(task, `${match}.activity.jsonl`)
  if (!jsonl) {
    log.fail(`activity for "${match}" is empty`)
    return 1
  }
  log.log(`${task.meta.id} · ${match} — agent activity`)
  log.log('')
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      continue
    }
    const ev = ActivityEvent.safeParse(raw)
    if (!ev.success) {
      continue
    }
    const e = ev.data
    if (e.item) {
      if (e.item.text) {
        log.log(e.item.text)
      } else if (e.item.command) {
        log.log(`→ ${e.item.command}`)
      } else if (e.item.type) {
        log.info(`· ${e.item.type}`)
      }
    } else if (e.type === 'assistant' && e.message?.content) {
      for (const c of e.message.content) {
        if (c.text) {
          log.log(c.text)
        } else if (c.name) {
          log.info(`→ ${c.name}`)
        }
      }
    }
  }
  return 0
}

// Drill into one task: what it set out to do, the conversation, the chosen plan,
// and where it landed (commit or block) — without digging through the task dir.
// With no query, defaults to the latest task in this worktree. With `step`, shows
// that step's agent activity. A lone arg that isn't a task is treated as a step
// of the latest task — so `factory show implement` works without the task id.
export async function printShow(ctx: WorkContext, query?: string, step?: string): Promise<number> {
  let task = query ? await findTask(ctx, query) : await latestTask(ctx)
  let stepArg = step
  if (query && !task && !step) {
    task = await latestTask(ctx)
    stepArg = query
  }
  if (!task) {
    log.fail(query ? `no task or step matching "${query}"` : 'no tasks in this worktree')
    return 1
  }
  if (stepArg) {
    return showActivity(task, stepArg)
  }
  const m = task.meta

  log.log(`${m.id}  [${m.status}]${m.note ? ` — ${m.note}` : ''}`)
  log.log(
    `verify: ${m.verify ?? '(none)'}  ·  created ${age(m.createdAt)} ago  ·  updated ${age(m.updatedAt)} ago`
  )

  const intent = await fileText(task, 'task.md')
  if (intent) {
    log.log('')
    log.log('## Intent')
    log.log(intent)
  }

  for (const [name, heading] of [
    ['questions.md', '## Open questions'],
    ['answers.md', '## Answers'],
    ['plan.final.md', '## Final plan'],
    ['risk.plan.md', '## Plan risk'],
    ['review.md', '## Review (last attempt)'],
    ['risk.md', '## Merge risk (last attempt)'],
    ['deploy.md', '## Deploy safety (last attempt)'],
    ['verify.log', '## Verify output (last attempt)'],
  ] as const) {
    const text = await fileText(task, name)
    if (text) {
      log.log('')
      log.log(heading)
      log.log(text)
    }
  }

  if (m.status === 'done' && m.commit) {
    log.log('')
    log.log(`## Committed as ${m.commit}`)
  }

  const steps = await activitySteps(task)
  if (steps.length > 0) {
    log.log('')
    log.log(`## Step activity  (factory show ${m.id} <step>)`)
    log.log(`  ${steps.join('  ')}`)
  }
  return 0
}

const pctOf = (r: number | null): string => (r === null ? '—' : `${Math.round(r * 100)}%`)
const tokens = (n: number | null): string => {
  if (n === null) {
    return '—'
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`
  }
  return `${n}`
}

function durMs(ms: number | null): string {
  if (ms === null) {
    return '—'
  }
  const s = Math.round(ms / 1000)
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return `${m}m`
  }
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d`
}

export function formatReport(report: Report): string[] {
  const lines: string[] = []
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const field = (name: string, val: string, note = '') =>
    lines.push(`  ${name.padEnd(16)} ${val}${note ? `   ${note}` : ''}`)
  const totalTokens = report.inputTokensTotal + report.outputTokensTotal

  lines.push(`factory report — ${plural(report.tasks, 'task')} · ${plural(report.runs, 'run')}`)
  lines.push('')
  field(
    'first-pass yield',
    pctOf(report.firstPassYield),
    'done w/ no retries, of implement attempts'
  )
  field('escalation rate', pctOf(report.escalationRate), plural(report.escalations, 'pause'))
  field('blocked rate', pctOf(report.blockedRate))
  field(
    'retry success',
    pctOf(report.retrySuccess),
    `of ${plural(report.retryRuns, 'retried run')}`
  )
  lines.push('')
  field(
    'cost',
    `input ${tokens(report.inputTokensTotal)} tok · output ${tokens(
      report.outputTokensTotal
    )} tok · total ${tokens(totalTokens)} tok · median ${tokens(
      report.tokensMedianPerTask
    )} tok/task`
  )
  field('cycle time', `median ${durMs(report.cycleMedianMs)}`)
  lines.push('')
  lines.push(`  outcomes:  ${report.outcomes.map((o) => `${o.outcome} ${o.count}`).join(' · ')}`)

  if (report.stages.length > 0) {
    const stageTokens = report.stages.reduce((sum, s) => sum + s.totalTokens, 0)
    const stageMs = report.stages.reduce((sum, s) => sum + s.ms, 0)
    const stageWidth = 14
    const tokenWidth = 7
    const shareWidth = 7

    lines.push('')
    lines.push('  stage cost and time:')
    lines.push(
      `    ${'stage'.padEnd(stageWidth)} ${'input'.padStart(tokenWidth)} ${'output'.padStart(
        tokenWidth
      )} ${'total'.padStart(tokenWidth)} ${'token %'.padStart(shareWidth)} ${'time'.padStart(
        tokenWidth
      )} ${'time %'.padStart(shareWidth)}`
    )
    for (const s of report.stages) {
      lines.push(
        `    ${s.stage.padEnd(stageWidth)} ${tokens(s.inputTokens).padStart(
          tokenWidth
        )} ${tokens(s.outputTokens).padStart(tokenWidth)} ${tokens(s.totalTokens).padStart(
          tokenWidth
        )} ${pctOf(stageTokens > 0 ? s.totalTokens / stageTokens : null).padStart(
          shareWidth
        )} ${durMs(s.ms).padStart(tokenWidth)} ${pctOf(
          stageMs > 0 ? s.ms / stageMs : null
        ).padStart(shareWidth)}`
      )
    }
  }

  return lines
}

// The telemetry roll-up across all the repo's tasks (the "manage by numbers"
// view). Reads the repo-level metrics db; degrades gracefully if it's missing or
// unreadable — never the thing that fails.
export function printReport(ctx: RepoContext): void {
  if (!existsSync(ctx.metricsPath)) {
    log.info('no telemetry yet — run some tasks first')
    return
  }
  let report: Report | null
  try {
    report = readReport(ctx.metricsPath)
  } catch (err) {
    log.warn(`telemetry: could not read metrics — ${err instanceof Error ? err.message : err}`)
    log.info('the db rebuilds itself on the next task run')
    return
  }
  if (!report) {
    log.info('no telemetry yet — run some tasks first')
    return
  }
  for (const line of formatReport(report)) {
    log.log(line)
  }
}
