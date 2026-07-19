import { appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { agentLabel, resolveAgentEffort, runAgent } from './agents.ts'
import type { ScanResult } from './args.ts'
import type { DELEGATE_OPTIONS } from './commands.ts'
import { type Agent, ReasoningEffortSchema } from './config.ts'
import { EffortSchema, ModelEffortSchema } from './effort.ts'
import { log } from './log.ts'

// In-flight delegation: implement/fix stages may hand a clearly-mechanical
// subtask to a cheaper `agents.implementers` entry. The whole protocol lives in
// this module — the runnable command the prompt advertises, the `factory
// delegate` handler behind it, and the usage ledger the conductor folds back
// into the task meter. Delegation goes through this wrapper rather than raw
// `claude`/`codex` invocations so it is CLI-neutral (plain bash, not any
// agent's built-in subagent tool), the delegating agent reads an answer-only
// stdout instead of a raw event stream, and delegated tokens are recorded
// instead of vanishing — neither parent CLI reports a bash child's spend.

const DelegatedUsageSchema = z.object({
  label: z.string(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  ms: z.number().default(0),
  effort: ModelEffortSchema.nullable().optional(),
})
export type DelegatedUsage = z.infer<typeof DelegatedUsageSchema>

// One usage ledger per task, in tmp rather than the task dir: a codex
// implementer's sandbox can write tmp and the worktree but not factory's home,
// and a file inside the worktree would dirty the diff the gates review.
export function delegateUsageFile(taskId: string): string {
  return `${tmpdir()}/factory-delegate-${taskId}.jsonl`
}

// The command line rendered into implement prompts for one pool entry.
// Contract: subtask prompt on stdin, delegate's report on stdout.
export function delegateCommand(agent: Agent, usageFile: string): string {
  const parts = ['factory', 'delegate', '--cli', agent.cli]
  if (agent.model) {
    parts.push('--model', agent.model)
  }
  if (agent.reasoningEffort) {
    parts.push('--reasoning-effort', agent.reasoningEffort)
  }
  if (agent.effort) {
    parts.push('--effort', agent.effort)
  }
  if (agent.provider) {
    parts.push('--provider', agent.provider)
  }
  parts.push('--usage-file', usageFile)
  return parts.join(' ')
}

// Drain the ledger: parse every valid line, skip garbage (the file is written
// inside an agent-controlled shell, so treat it as untrusted telemetry), and
// delete the file so the next implement/fix pass starts a fresh ledger.
export async function collectDelegatedUsage(file: string): Promise<DelegatedUsage[]> {
  const ledger = Bun.file(file)
  if (!(await ledger.exists())) {
    return []
  }
  const text = await ledger.text()
  await rm(file, { force: true })
  const records: DelegatedUsage[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const record = DelegatedUsageSchema.safeParse(parsed)
    if (record.success) {
      records.push(record.data)
    }
  }
  return records
}

const USAGE =
  'usage: <subtask prompt on stdin> | factory delegate --cli codex|claude ' +
  '[--model <m>] [--effort <e>] [--reasoning-effort <e>] [--provider <p>] ' +
  '[--usage-file <path>]'

export async function delegateCli(scan: ScanResult<typeof DELEGATE_OPTIONS>): Promise<number> {
  if (!scan.ok) {
    log.fail(USAGE)
    return 1
  }
  const cli = scan.flags['--cli'][0]
  if (cli !== 'codex' && cli !== 'claude') {
    log.fail(USAGE)
    return 1
  }
  const legacyRaw = scan.flags['--reasoning-effort'][0]
  const legacy = legacyRaw === undefined ? null : ReasoningEffortSchema.safeParse(legacyRaw)
  if (legacy && !legacy.success) {
    log.fail(`--reasoning-effort must be one of ${ReasoningEffortSchema.options.join(', ')}`)
    return 1
  }
  const effortRaw = scan.flags['--effort'][0]
  const effort = effortRaw === undefined ? null : EffortSchema.safeParse(effortRaw)
  if (effort && !effort.success) {
    log.fail(`--effort must be one of ${EffortSchema.options.join(', ')}`)
    return 1
  }
  if (effort?.success && legacy?.success) {
    log.fail('--effort and --reasoning-effort cannot both be set')
    return 1
  }
  if (legacy?.success && cli === 'claude') {
    log.fail('--reasoning-effort is only supported for the codex cli')
    return 1
  }
  const model = scan.flags['--model'][0]
  const provider = scan.flags['--provider'][0]
  const usageFile = scan.flags['--usage-file'][0]
  // The conductor renders these flags from an already-validated AgentSpec, so
  // the cross-field refinements (provider implies model, effort is codex-only)
  // are not re-checked here.
  const agent: Agent = {
    cli,
    ...(model !== undefined && { model }),
    ...(effort?.success && { effort: effort.data }),
    ...(legacy?.success && { reasoningEffort: legacy.data }),
    ...(provider !== undefined && { provider }),
  }
  const prompt = (await new Response(Bun.stdin.stream()).text()).trim()
  if (!prompt) {
    log.fail(`delegate: no prompt on stdin\n${USAGE}`)
    return 1
  }
  const start = Date.now()
  try {
    const result = await runAgent(agent, { root: process.cwd(), prompt, access: 'write' })
    if (usageFile !== undefined) {
      // Telemetry is best-effort everywhere in factory: a failed append must
      // not fail a delegation that produced real work.
      try {
        const record: DelegatedUsage = {
          label: agentLabel(agent),
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          ms: Date.now() - start,
          effort: resolveAgentEffort(agent).effort,
        }
        await appendFile(usageFile, `${JSON.stringify(record)}\n`)
      } catch (err) {
        log.warn(`delegate: usage append failed: ${err instanceof Error ? err.message : err}`)
      }
    }
    log.log(result.text)
    return 0
  } catch (err) {
    log.fail(`delegate ${agentLabel(agent)}: ${err instanceof Error ? err.message : err}`)
    return 1
  }
}
