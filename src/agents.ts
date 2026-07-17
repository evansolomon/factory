import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import type { Agent } from './config.ts'
import { type RunResult, run } from './exec.ts'
import { log } from './log.ts'

// One runner for both CLIs (codex, claude), parameterized by the configured
// agent (cli + optional model) and the access a stage needs. Prompts go in on
// stdin; the final message + token usage come back as an AgentResult and, if
// outFile is given, the text is written there as the stage artifact AND the raw
// agent event stream (reasoning + tool calls, line by line) is persisted beside
// it as <base>.activity.jsonl, teed live as the step runs (so `tail -f` works
// mid-step) — for inspecting what an agent actually did, per step.

export type Usage = { inputTokens: number; outputTokens: number }
export type AgentResult = { text: string; usage: Usage }
export type Access = 'read' | 'research' | 'write' | 'full'
export type AgentRun = { root: string; prompt: string; access: Access; outFile?: string }

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 }

// Unattended CLIs still run user-level Stop hooks. Keep those hooks from treating
// pipeline turns as interactive pane completions; Factory's own lifecycle hooks
// run from the parent and retain TMUX_PANE.
export function unattendedAgentEnv(
  parentEnv: Record<string, string | undefined> = process.env
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    if (key !== 'TMUX_PANE' && value !== undefined) {
      env[key] = value
    }
  }
  return env
}

// Human-facing label for logs/artifacts.
export function agentLabel(agent: Agent): string {
  return agent.model ? `${agent.cli}:${agent.model}` : agent.cli
}

// Where a step's raw agent event stream is persisted, beside its final-message
// artifact: e.g. review.md → review.activity.jsonl.
function activityPath(outFile: string): string {
  return `${outFile.replace(/\.md$/, '')}.activity.jsonl`
}

// A single call gets a couple of retries on a nonzero exit, to ride out transient
// failures (network blips, rate limits) before bubbling up and blocking the task.
const RETRY_DELAYS_MS = [3000, 8000]

async function runWithRetry(
  label: string,
  cmd: string[],
  opts: { cwd: string; stdin: string; streamTo?: string; env: Record<string, string> }
): Promise<RunResult> {
  let res = await run(cmd, opts)
  for (let attempt = 0; res.code !== 0 && attempt < RETRY_DELAYS_MS.length; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt] ?? 8000
    log.warn(
      `${label}: exited ${res.code}; retrying in ${delay / 1000}s ` +
        `(${attempt + 1}/${RETRY_DELAYS_MS.length})`
    )
    await Bun.sleep(delay)
    res = await run(cmd, opts)
  }
  return res
}

// codex --json emits one `turn.completed` per exec carrying the session-total
// usage (verified: a single event even across tool calls). Take the last.
const CodexTurn = z.object({
  type: z.literal('turn.completed'),
  usage: z.object({
    input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
  }),
})

function parseCodexUsage(label: string, stdout: string): Usage {
  let usage: Usage | null = null
  for (const line of stdout.split('\n')) {
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
    const result = CodexTurn.safeParse(parsed)
    if (result.success) {
      usage = {
        inputTokens: result.data.usage.input_tokens,
        outputTokens: result.data.usage.output_tokens,
      }
    }
  }
  if (!usage) {
    // Degrading to zero is deliberate (usage must never break the loop), but it
    // must not be silent: zeroed rows systematically understate telemetry.
    log.warn(`${label}: no turn.completed usage in codex stream; recording zero usage`)
    return ZERO_USAGE
  }
  return usage
}

// claude --output-format stream-json emits one JSON event per line; the final
// `result` event carries the output text + session usage. Lenient on purpose:
// every field defaults and a missing event degrades to raw text + zeroed usage
// rather than throwing and killing the loop.
const ClaudeResultEvent = z.object({
  type: z.literal('result'),
  result: z.string().default(''),
  usage: z
    .object({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().default(0),
      cache_creation_input_tokens: z.number().default(0),
    })
    .default(() => ({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })),
  // Per-model session totals (camelCase, unlike `usage`). Unlike `usage`, which
  // covers only the main loop, this includes the CLI's native subagents and
  // auxiliary calls — the complete spend of the invocation.
  modelUsage: z
    .record(
      z.string(),
      z.object({
        inputTokens: z.number().default(0),
        outputTokens: z.number().default(0),
        cacheReadInputTokens: z.number().default(0),
        cacheCreationInputTokens: z.number().default(0),
      })
    )
    .optional(),
})

export function parseClaudeStream(label: string, stdout: string): AgentResult {
  let out: AgentResult | null = null
  for (const line of stdout.split('\n')) {
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
    const ev = ClaudeResultEvent.safeParse(parsed)
    if (ev.success) {
      const models = Object.values(ev.data.modelUsage ?? {})
      const u = ev.data.usage
      // Prefer summing modelUsage: it covers the whole session (native
      // subagents included), where `usage` covers only the main loop — an
      // implementer that spawns its own subagents would otherwise under-report.
      // Input counts include cache hits/writes: total tokens fed to the model.
      const usage: Usage =
        models.length > 0
          ? models.reduce(
              (acc, m) => ({
                inputTokens:
                  acc.inputTokens +
                  m.inputTokens +
                  m.cacheReadInputTokens +
                  m.cacheCreationInputTokens,
                outputTokens: acc.outputTokens + m.outputTokens,
              }),
              ZERO_USAGE
            )
          : {
              inputTokens:
                u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
              outputTokens: u.output_tokens,
            }
      out = { text: ev.data.result.trim(), usage }
    }
  }
  if (!out) {
    log.warn(`${label}: no result event in claude stream; usage unknown`)
    return { text: stdout.trim(), usage: ZERO_USAGE }
  }
  return out
}

// access → filesystem reach. read: explore only. research: read + network for
// data lookup, no push — codex needs workspace-write here since read-only
// blocks the network outright (so this lone, non-parallel stage can also
// technically write; that's fine, it shows in the reviewed diff). write: edit
// the worktree. full: also push (for the delivery step). Network is on for
// every workspace-write level (research lookups, `factory delegate` children
// spawned by implement stages), matching claude's bypassPermissions posture;
// only read stays network-less, inherent to codex's read-only sandbox.
const CODEX_SANDBOX: Record<Access, string> = {
  read: 'read-only',
  research: 'workspace-write',
  write: 'workspace-write',
  full: 'danger-full-access',
}

async function runCodex(agent: Agent, opts: AgentRun): Promise<AgentResult> {
  // codex --json puts events on stdout, so the final message must go to a file.
  const out = opts.outFile ?? `${tmpdir()}/factory-codex-${Date.now()}.md`
  const cmd = [
    'codex',
    'exec',
    '-C',
    opts.root,
    '-s',
    CODEX_SANDBOX[opts.access],
    '-c',
    'approval_policy="never"',
    // Force network on for every workspace-write level regardless of user
    // config — research needs data lookup, and implement/fix stages may spawn
    // `factory delegate` children that must reach a model API.
    ...(CODEX_SANDBOX[opts.access] === 'workspace-write'
      ? ['-c', 'sandbox_workspace_write.network_access=true']
      : []),
    // Route to a non-default OpenAI-compatible backend (xAI, local/hosted OSS)
    // defined in ~/.codex/config.toml; absent → codex's default provider.
    ...(agent.provider ? ['-c', `model_provider="${agent.provider}"`] : []),
    ...(agent.reasoningEffort ? ['-c', `model_reasoning_effort="${agent.reasoningEffort}"`] : []),
    '--json',
    ...(agent.model ? ['-m', agent.model] : []),
    '-o',
    out,
    '-',
  ]
  // stdout is the --json event stream (reasoning + tool calls): tee it live to
  // the activity log so it's tail-able mid-step.
  const res = await runWithRetry(agentLabel(agent), cmd, {
    cwd: opts.root,
    stdin: opts.prompt,
    streamTo: opts.outFile ? activityPath(opts.outFile) : undefined,
    env: unattendedAgentEnv(),
  })
  if (res.code !== 0) {
    throw new Error(`codex exec failed (exit ${res.code}): ${res.stderr || res.stdout}`.trim())
  }
  const file = Bun.file(out)
  const text = (await file.exists()) ? (await file.text()).trim() : ''
  if (!opts.outFile) {
    await rm(out, { force: true })
  }
  return { text, usage: parseCodexUsage(agentLabel(agent), res.stdout) }
}

// Pipeline stages run unattended, but the claude CLI still loads the USER'S
// interactive CLAUDE.md — whose rules ("ask before running tests", "ask before
// git actions") assume a human is present. In real runs, autonomous implementers
// sat waiting to ask an absent human for permission. This preamble re-scopes
// those rules for the pipeline context; it does not touch repo AGENTS.md
// conventions, which remain binding.
const UNATTENDED_PREAMBLE =
  '[Unattended pipeline stage] You are one stage of an autonomous coding pipeline. ' +
  'No human is present and nothing can answer questions mid-stage. Interactive-session ' +
  'rules from user-level CLAUDE.md (asking permission to run tests/commands, pausing for ' +
  'approval) do NOT apply here — the pipeline itself gates side effects. Never read ' +
  'files outside this repository (private memory/config dirs) unless they are standard ' +
  'toolchain files needed to run the repo.\n\n'

async function runClaude(agent: Agent, opts: AgentRun): Promise<AgentResult> {
  // read/research disallow Claude's dedicated edit tools, but Bash remains
  // available because read-only git/rg/etc. are too valuable during planning and
  // review. This is prompt-disciplined, not a filesystem sandbox: shell commands
  // can still mutate if the model ignores instructions.
  const noEdits = opts.access === 'read' || opts.access === 'research'
  const tools = noEdits ? ['--disallowedTools', 'Edit', 'Write', 'NotebookEdit'] : []
  const cmd = [
    'claude',
    '-p',
    '--add-dir',
    opts.root,
    // stream-json (requires --verbose) emits the event stream so we can persist
    // the line-by-line activity, not just the final message.
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    ...(agent.model ? ['--model', agent.model] : []),
    ...tools,
  ]
  const res = await runWithRetry(agentLabel(agent), cmd, {
    cwd: opts.root,
    stdin: `${UNATTENDED_PREAMBLE}${opts.prompt}`,
    streamTo: opts.outFile ? activityPath(opts.outFile) : undefined,
    env: unattendedAgentEnv(),
  })
  if (res.code !== 0) {
    throw new Error(`claude failed (exit ${res.code}): ${res.stderr || res.stdout}`.trim())
  }
  const result = parseClaudeStream(agentLabel(agent), res.stdout)
  if (opts.outFile) {
    await Bun.write(opts.outFile, result.text)
  }
  return result
}

export async function runAgent(agent: Agent, opts: AgentRun): Promise<AgentResult> {
  return agent.cli === 'codex' ? runCodex(agent, opts) : runClaude(agent, opts)
}
