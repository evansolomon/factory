import { dirname } from 'node:path'
import { z } from 'zod'
import { mainWorktreeRoot, repoRoot } from './git.ts'
import { OnCompleteSchema } from './on-complete.ts'

// An agent is a CLI, optionally pinned to a model. Accepts a bare "codex"/
// "claude" or { cli, model } in config; normalized to Agent everywhere else.
const AgentSpecSchema = z
  .union(
    [
      z.enum(['codex', 'claude']),
      z.object({
        cli: z.enum(['codex', 'claude']),
        model: z.string().optional(),
        // Selects a non-default codex backend — an OpenAI-compatible provider
        // configured in ~/.codex/config.toml (base_url/env_key/wire_api) —
        // passed through as `-c model_provider=`. This is how a single agent
        // routes to xAI or a local/hosted OSS model without a new adapter.
        provider: z.string().optional(),
      }),
    ],
    {
      error:
        'expected "codex" or "claude", or { "cli": "codex"|"claude", "model"?: string, "provider"?: string }',
    }
  )
  // provider routes through codex's `-c model_provider=`; claude has no
  // equivalent CLI flag (it selects backends via env/Bedrock/Vertex), so reject
  // it on claude rather than silently ignore it.
  .refine((spec) => typeof spec === 'string' || !spec.provider || spec.cli === 'codex', {
    error: 'provider is only supported for the codex cli',
    path: ['provider'],
  })
  // A custom provider won't recognize codex's default model name, so an explicit
  // model is required — fail here, not deep in a codex error mid-run.
  .refine((spec) => typeof spec === 'string' || !spec.provider || Boolean(spec.model), {
    error: 'provider requires an explicit model',
    path: ['provider'],
  })
type AgentSpec = z.infer<typeof AgentSpecSchema>
export type Agent = { cli: 'codex' | 'claude'; model?: string; provider?: string }

function normAgent(spec: AgentSpec): Agent {
  return typeof spec === 'string' ? { cli: spec } : spec
}

// Which agents play which role. planners is the ensemble (≥2 → cross-critique);
// implementer also runs triage/reconcile/select; reviewer does the adversarial
// review; delivery runs onComplete. Each defaults independently when omitted.
const AgentsSchema = z.object({
  planners: z.array(AgentSpecSchema).default((): AgentSpec[] => ['codex', 'claude']),
  implementer: AgentSpecSchema.default('codex'),
  reviewer: AgentSpecSchema.default('claude'),
  delivery: AgentSpecSchema.default('claude'),
})

const AskSchema = z
  .object({
    agent: AgentSpecSchema.default('claude'),
  })
  .default((): { agent: AgentSpec } => ({ agent: 'claude' }))

type AgentsConfig = {
  planners: AgentSpec[]
  implementer: AgentSpec
  reviewer: AgentSpec
  delivery: AgentSpec
}

export type RoleAgents = {
  planners: Agent[]
  implementer: Agent
  reviewer: Agent
  delivery: Agent
}

// Config lives in `.factory.json` files and CASCADES: resolution walks from
// the worktree root up the directory tree, merging every file it finds, with the
// closest (deepest) winning — like git/eslint config. This lets you drop one
// file at e.g. ~/repos/code/ that applies to every worktree of that repo
// (uncommitted, per-machine) while a different repo gets its own. Beneath the
// whole tree sits one global base, `~/.factory/config.json` or
// `$FACTORY_HOME/config.json` (lowest priority, applies everywhere) — overridden
// by any `.factory.json` in the cascade.
//   dir relative      → in-repo at <root>/<dir> (committed with the branch)
//   dir absolute / ~  → a global base; state goes under <base>/<worktree-key>
//   dir omitted       → ~/.factory/sessions/<worktree-key> (or FACTORY_HOME)
const HookMapSchema = z.record(z.string(), z.array(z.string()))

const ConfigSchema = z.object({
  dir: z.string().optional(),
  // Hard-cap backstop on auto-fix iterations after a failed gate. Termination is
  // normally by the convergence judge (keep fixing while failures are genuinely
  // new, stop when stuck); this just bounds a runaway loop. 0 disables auto-fix.
  retries: z.number().int().min(0).default(10),
  // Triage each task first; trivial ones skip the plan ensemble and go straight
  // to implement (still reviewed + verified). false = always run the full flow.
  triage: z.boolean().default(true),
  // Run a dedicated red-team security gate on the implemented diff (every task,
  // both paths), feeding the same auto-fix retry loop as the review gate.
  // false = skip it.
  security: z.boolean().default(true),
  // Run the UI/UX lenses for user-facing work: an information-architecture critique
  // in planning, design-context for the implementer, and a design-consistency review
  // gate on the diff. Auto-gated per task (triage flags user-facing; the review also
  // fires when the diff touches UI files). false = never run them.
  ux: z.boolean().default(true),
  // Where the clean, final plan for each task is written (one file per task,
  // no meta/intermediate artifacts) — meant to be committed as documentation.
  // Relative to the repo root unless absolute/~. null disables.
  plansDir: z.string().nullable().default('.coding-agent-plans'),
  // Snapshot every terminal task (done/blocked) as an eval candidate under the
  // repo's eval-candidates/ — spec + verify + base commit + the reference diff —
  // so a regression set accrues from real use. Best-effort. false = don't capture.
  captureEvals: z.boolean().default(true),
  // On a block, run a postmortem agent that diagnoses the root cause (writes
  // postmortem.md for triage) and distills a generalizable lesson candidate.
  // Best-effort; false falls back to a raw block-reason candidate.
  postmortem: z.boolean().default(true),
  // On a verify failure, run a full-access "doctor" that classifies the failure
  // (code defect vs environment/setup vs flake) and, for environment problems
  // (missing deps, an uninstalled tool, an un-run build/codegen step, a service
  // that isn't up), repairs the environment in place and re-runs — so the loop
  // self-unblocks instead of burning the fix budget re-implementing code that was
  // never the problem. false = a verify failure always routes to the code-fix loop.
  remediate: z.boolean().default(true),
  // What to do when a task completes (opt-in; a full-permission agent runs it).
  //   { "skill": "name" }  → run that skill
  //   { "policy": "text" } → follow a free-text delivery policy
  //   null (default)       → nothing; you push manually
  onComplete: OnCompleteSchema.nullable().default(null),
  // Lifecycle hooks: event name → shell commands run when factory reaches that
  // event (see hooks.ts). Lets the surrounding environment react — tmux, desktop
  // notifications, dashboards — without factory knowing about it. Concatenated
  // across the cascade rather than closest-wins (see loadConfig).
  hooks: HookMapSchema.default({}),
  // Which agents fill each role. Omit to use the defaults below.
  agents: AgentsSchema.default(
    (): AgentsConfig => ({
      planners: ['codex', 'claude'],
      implementer: 'codex',
      reviewer: 'claude',
      delivery: 'claude',
    })
  ),
  // Conversational, read-only questions about factory's saved task state. Kept
  // separate from the pipeline roles because `ask` is a context-building command,
  // not a planning/review/delivery stage.
  ask: AskSchema,
})

export type Config = z.infer<typeof ConfigSchema>

// A bad value in a .factory.json file (valid JSON, wrong type/option). Carries
// a pre-formatted, human-readable message; the CLI prints it cleanly instead of
// dumping a zod stack trace, while genuine bugs still surface their stack.
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

function formatConfigError(err: z.ZodError, sources: string[]): string {
  const issues = err.issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join('.') : '(root)'
    return `  ${path}: ${i.message}`
  })
  const where = sources.length > 0 ? `set in:\n${sources.map((s) => `  ${s}`).join('\n')}\n\n` : ''
  return `invalid .factory.json config\n\n${where}problems:\n${issues.join('\n')}`
}

// Walk from `root` up to the filesystem root, collecting the directories to
// check for `.factory.json` (deepest first).
function ancestorDirs(root: string): string[] {
  const dirs: string[] = []
  let d = root
  while (true) {
    dirs.push(d)
    const parent = dirname(d)
    if (parent === d) {
      break
    }
    d = parent
  }
  return dirs
}

const CONFIG_NAME = '.factory.json'

// A single global config, applied as the lowest-priority base beneath the whole
// cascade so it covers every repo regardless of where it lives in the filesystem.
// Lives with the global state at ~/.factory/config.json, or
// $FACTORY_HOME/config.json when FACTORY_HOME is set (not a `.factory.json`
// in the dir tree).
export function globalConfigFile(): string {
  return `${factoryHome()}/config.json`
}

export function autoUpgradeStateFile(): string {
  return `${factoryHome()}/auto-upgrade.json`
}

// Candidate config files in priority order, lowest first: the global base, then
// each ancestor from the filesystem root down to the worktree (closest wins).
function configCandidates(root: string): string[] {
  const global = globalConfigFile()
  const ancestors = ancestorDirs(root)
    .reverse()
    .map((dir) => `${dir}/${CONFIG_NAME}`)
  return global ? [global, ...ancestors] : ancestors
}

// Hooks CONCATENATE across the cascade (deduped) instead of closest-wins, so a
// global tmux hook applies to every repo while a repo can still add its own —
// matching how Claude Code merges hooks additively.
function mergeHooks(
  base: Record<string, string[]> | undefined,
  incoming: Record<string, string[]>
): Record<string, string[]> {
  const merged = { ...(base ?? {}) }
  for (const [event, commands] of Object.entries(incoming)) {
    merged[event] = [...new Set([...(merged[event] ?? []), ...commands])]
  }
  return merged
}

// The config files that actually exist, closest (highest priority) first.
export async function configSources(root: string): Promise<string[]> {
  const found: string[] = []
  for (const path of configCandidates(root)) {
    if (await Bun.file(path).exists()) {
      found.push(path)
    }
  }
  return found.reverse()
}

export async function loadConfig(root: string): Promise<Config> {
  // Apply candidates lowest priority first (global base, then topmost ancestor
  // down to the worktree root) so the closest file's keys win. Malformed files
  // are skipped, not fatal.
  let merged: Record<string, unknown> = {}
  const sources: string[] = []
  for (const path of configCandidates(root)) {
    if (!(await Bun.file(path).exists())) {
      continue
    }
    let raw: unknown
    try {
      raw = await Bun.file(path).json()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ConfigError(`invalid JSON config\n\n  ${path}: ${message}`)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigError(`invalid config\n\n  ${path}: expected a JSON object`)
    }

    let hooks: Record<string, string[]> | null = null
    if ('hooks' in raw) {
      const result = HookMapSchema.safeParse(raw.hooks)
      if (!result.success) {
        throw new ConfigError(formatConfigError(result.error, [path]))
      }
      hooks = result.data
    }

    const priorHooks = merged['hooks'] as Record<string, string[]> | undefined
    merged = { ...merged, ...raw }
    if (hooks) {
      merged['hooks'] = mergeHooks(priorHooks, hooks)
    }
    sources.push(path)
  }
  const result = ConfigSchema.safeParse(merged)
  if (!result.success) {
    throw new ConfigError(formatConfigError(result.error, sources))
  }
  return result.data
}

export type WorkContext = {
  root: string
  config: Config
  // Base dir for this worktree's state (its tasks/ live here).
  stateDir: string
  tasksDir: string
  // Where the clean final plan per task is written (committed docs), or null.
  plansDir: string | null
  // Normalized role → agent(s) for this worktree.
  agents: RoleAgents
  // Agent used only for `factory ask`.
  askAgent: Agent
  // Repo-level state dir (keyed by the main worktree, like the backlog), shared
  // across the repo's worktrees — holds the telemetry db and LESSONS (the meta
  // loop), so both accumulate across worktrees instead of resetting per branch.
  repoStateDir: string
  metricsPath: string
}

function resolveAgents(config: Config): RoleAgents {
  const a = config.agents
  return {
    planners: a.planners.map(normAgent),
    implementer: normAgent(a.implementer),
    reviewer: normAgent(a.reviewer),
    delivery: normAgent(a.delivery),
  }
}

function expandTilde(p: string): string {
  return p.startsWith('~') ? `${process.env['HOME'] ?? ''}${p.slice(1)}` : p
}

function factoryHome(): string {
  return expandTilde(process.env['FACTORY_HOME'] ?? '~/.factory')
}

// Stable per-worktree key for namespacing global state. Any external integration
// that locates a worktree's state (e.g. a shell prompt segment) must derive the key
// the same way — keep them in sync.
function worktreeKey(root: string): string {
  return root.replace(/\//g, '-').replace(/^-+/, '')
}

function resolveStateDir(root: string, config: Config): string {
  const dir = config.dir
  if (dir) {
    if (dir.startsWith('/') || dir.startsWith('~')) {
      return `${expandTilde(dir)}/${worktreeKey(root)}`
    }
    return `${root}/${dir}`
  }
  // Per-worktree state nests under sessions/ so it doesn't clutter the factory home
  // root, which holds config.json + hooks/. (An explicit absolute/~ `dir` above is
  // the user's own base — left as <base>/<key>, no sessions/ namespace imposed.)
  return `${factoryHome()}/sessions/${worktreeKey(root)}`
}

function resolvePlansDir(root: string, config: Config): string | null {
  const p = config.plansDir
  if (!p) {
    return null
  }
  if (p.startsWith('/') || p.startsWith('~')) {
    return expandTilde(p)
  }
  return `${root}/${p}`
}

export async function loadContext(cwd: string): Promise<WorkContext> {
  const root = await repoRoot(cwd)
  const config = await loadConfig(root)
  const stateDir = resolveStateDir(root, config)
  const mainRoot = await mainWorktreeRoot(cwd)
  const mainConfig = mainRoot === root ? config : await loadConfig(mainRoot)
  const repoStateDir = resolveStateDir(mainRoot, mainConfig)
  return {
    root,
    config,
    stateDir,
    tasksDir: `${stateDir}/tasks`,
    plansDir: resolvePlansDir(root, config),
    agents: resolveAgents(config),
    askAgent: normAgent(config.ask.agent),
    repoStateDir,
    metricsPath: `${repoStateDir}/metrics.db`,
  }
}

// Repo-level context: the backlog and telemetry are shared across all of a repo's
// worktrees, so they're keyed by the main worktree (not the current linked one).
export type RepoContext = {
  mainRoot: string
  config: Config
  backlogDir: string
  metricsPath: string
  // Normalized role → agent(s); sharpening on `backlog add` uses the implementer.
  agents: RoleAgents
}

export async function loadRepoContext(cwd: string): Promise<RepoContext> {
  const mainRoot = await mainWorktreeRoot(cwd)
  const config = await loadConfig(mainRoot)
  const stateDir = resolveStateDir(mainRoot, config)
  return {
    mainRoot,
    config,
    backlogDir: `${stateDir}/backlog`,
    metricsPath: `${stateDir}/metrics.db`,
    agents: resolveAgents(config),
  }
}
