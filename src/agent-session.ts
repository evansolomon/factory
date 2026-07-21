import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { scanArgs } from './args.ts'
import { SESSION_OPTIONS } from './commands.ts'
import type { WorkContext } from './config.ts'
import { log } from './log.ts'
import { prototypePrimaryArtifactPath } from './prototype.ts'
import { findTask, latestTask, type Task, writeArtifact } from './task.ts'

export type InteractiveAgent = 'codex' | 'claude'

const SUMMARY_ARTIFACT = 'agent-session.summary.md'
const HANDOFF_ARTIFACT = 'agent-session.md'

const ARTIFACT_ORDER = [
  'task.md',
  'meta.json',
  'feedback.md',
  'brief.html',
  'human-feedback.md',
  'delivery.md',
  'plan.md',
  'plan.final.md',
  'risk.plan.md',
  'risk.shape.md',
  'decomposition.md',
  'decomposition.raw.json',
  'decomposition.repair.json',
  'prototype.md',
  'implement.log.md',
  'diff.patch',
  'review.md',
  'security.md',
  'risk.md',
  'deploy.md',
  'ux.md',
  'consolidated.md',
  'consolidated.history.md',
  'failures.jsonl',
  'verify.log',
  'proof.md',
  'postmortem.md',
  'ship.md',
]

type LaunchResult = { code: number }
type Launcher = (cmd: string[], opts: { cwd: string }) => Promise<LaunchResult>

type SessionRequest = {
  agent: InteractiveAgent
  taskQuery: string | null
}

async function defaultLauncher(cmd: string[], opts: { cwd: string }): Promise<LaunchResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return { code: await proc.exited }
}

function parseAgent(value: string): InteractiveAgent | null {
  return value === 'codex' || value === 'claude' ? value : null
}

export function parseAgentSessionArgs(
  args: string[],
  defaultAgent: InteractiveAgent
): { ok: true; request: SessionRequest } | { ok: false; message: string } {
  const usage = 'usage: factory session [--agent codex|claude] [task-id]'
  // Single-dash tokens are positional task queries here, not options.
  const scan = scanArgs(SESSION_OPTIONS, args, { unknown: 'error', flagish: 'double-dash' })
  if (!scan.ok) {
    if (scan.error.kind === 'unknown-option') {
      return { ok: false, message: `unknown option ${scan.error.option}` }
    }
    return { ok: false, message: usage }
  }

  let agent = defaultAgent
  for (const value of scan.flags['--agent']) {
    if (!value) {
      return { ok: false, message: usage }
    }
    const parsed = parseAgent(value)
    if (!parsed) {
      return { ok: false, message: `unknown agent "${value}" (expected codex or claude)` }
    }
    agent = parsed
  }

  if (scan.positionals.length > 1) {
    return { ok: false, message: usage }
  }

  return { ok: true, request: { agent, taskQuery: scan.positionals[0] ?? null } }
}

async function existingArtifactNames(task: Task): Promise<string[]> {
  const existing = new Set(
    (await readdir(task.dir)).filter(
      (name) =>
        !name.startsWith('.') &&
        !name.endsWith('.tmp') &&
        name !== HANDOFF_ARTIFACT &&
        name !== SUMMARY_ARTIFACT
    )
  )
  const ordered = ARTIFACT_ORDER.filter((name) => existing.has(name))
  const extra = [...existing]
    .filter(
      (name) =>
        !ARTIFACT_ORDER.includes(name) && (name.endsWith('.md') || name.endsWith('.activity.jsonl'))
    )
    .sort()
  const primaryPrototype = await prototypePrimaryArtifactPath(task)
  const dynamic = primaryPrototype && !ordered.includes(primaryPrototype) ? [primaryPrototype] : []
  return [...ordered, ...dynamic, ...extra]
}

function artifactLine(task: Task, name: string): string {
  return `- ${name}: ${resolve(task.dir, name)}`
}

export async function buildAgentSessionHandoff(
  ctx: WorkContext,
  task: Task,
  agent: InteractiveAgent,
  now: Date = new Date()
): Promise<{ artifact: string; summaryPath: string; content: string }> {
  const summaryPath = resolve(task.dir, SUMMARY_ARTIFACT)
  const artifactPath = resolve(task.dir, HANDOFF_ARTIFACT)
  const artifactNames = await existingArtifactNames(task)
  const references =
    artifactNames.length > 0
      ? artifactNames.map((name) => artifactLine(task, name)).join('\n')
      : '(no task artifacts found)'

  const content = `# Agent Session Handoff

Generated: ${now.toISOString()}

## Task
- id: ${task.id}
- status: ${task.meta.status}
- agent: ${agent}
- commit: ${task.meta.commit ?? '(none)'}
- verify: ${task.meta.verify ?? '(none)'}
- task dir: ${resolve(task.dir)}
- worktree: ${ctx.root}

## References
${references}

## Factory Commands
- show task: factory show ${task.id}
- ask saved state: factory ask ${task.id}
- record follow-up feedback: factory feedback ${task.id} --edit

## Session Instructions
- Start by reading this handoff and the referenced artifacts that are relevant.
- Work with the human interactively on small follow-up tweaks.
- Do not commit unless the human explicitly asks.
- Before ending, append a concise summary to ${summaryPath}.

Suggested summary sections:
- What changed
- Files touched
- Checks run and results
- Remaining follow-up
- Anything factory should consume later
`

  await writeArtifact(task, HANDOFF_ARTIFACT, content)
  return { artifact: artifactPath, summaryPath, content }
}

export function agentSessionPrompt(input: {
  taskId: string
  handoffPath: string
  summaryPath: string
}): string {
  return `You are taking over after factory task ${input.taskId}.

Read this handoff first:
${input.handoffPath}

Use the referenced factory artifacts as context.
Work interactively with the human on follow-up tweaks.
Keep the scope narrow. Do not commit unless the human explicitly asks.

Before ending the session, append a concise summary to:
${input.summaryPath}
`
}

export function agentSessionCommand(input: {
  agent: InteractiveAgent
  root: string
  taskId: string
  handoffPath: string
  summaryPath: string
}): string[] {
  const prompt = agentSessionPrompt({
    taskId: input.taskId,
    handoffPath: input.handoffPath,
    summaryPath: input.summaryPath,
  })
  return input.agent === 'codex'
    ? ['codex', '-C', input.root, '--dangerously-bypass-approvals-and-sandbox', prompt]
    : ['claude', '--add-dir', input.root, '--dangerously-skip-permissions', prompt]
}

async function targetTask(ctx: WorkContext, query: string | null): Promise<Task | null> {
  return query ? await findTask(ctx, query) : await latestTask(ctx, ['done'])
}

export async function openAgentSession(
  ctx: WorkContext,
  args: string[],
  opts: { defaultAgent?: InteractiveAgent; commandName?: string; launcher?: Launcher } = {}
): Promise<number> {
  const parsed = parseAgentSessionArgs(args, opts.defaultAgent ?? 'codex')
  if (!parsed.ok) {
    log.fail(parsed.message)
    return 1
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log.fail(`factory ${opts.commandName ?? 'session'} needs an interactive terminal`)
    return 1
  }

  const task = await targetTask(ctx, parsed.request.taskQuery)
  if (!task) {
    log.fail(
      parsed.request.taskQuery
        ? `no task matching ${parsed.request.taskQuery}`
        : 'no done task in this worktree'
    )
    return 1
  }

  const handoff = await buildAgentSessionHandoff(ctx, task, parsed.request.agent)
  log.info(`wrote ${handoff.artifact}`)
  log.info(`summary target: ${handoff.summaryPath}`)

  const cmd = agentSessionCommand({
    agent: parsed.request.agent,
    root: ctx.root,
    taskId: task.id,
    handoffPath: handoff.artifact,
    summaryPath: handoff.summaryPath,
  })
  const result = await (opts.launcher ?? defaultLauncher)(cmd, { cwd: ctx.root })
  const summary = Bun.file(handoff.summaryPath)
  if (!(await summary.exists()) || !(await summary.text()).trim()) {
    log.warn(`no summary written at ${handoff.summaryPath}`)
  }
  return result.code
}
