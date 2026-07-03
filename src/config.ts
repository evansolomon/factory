import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { z } from 'zod'
import { mainWorktreeRoot, originUrl, repoRoot } from './git.ts'
import { log } from './log.ts'

export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh'])
type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>

// An agent is a CLI, optionally pinned to a model and Codex reasoning effort.
// Accepts a bare "codex"/"claude" or an object in config; normalized to Agent
// everywhere else.
const AgentSpecSchema = z
  .union(
    [
      z.enum(['codex', 'claude']),
      z.object({
        cli: z.enum(['codex', 'claude']),
        model: z.string().optional(),
        reasoningEffort: ReasoningEffortSchema.optional(),
        // Selects a non-default codex backend — an OpenAI-compatible provider
        // configured in ~/.codex/config.toml (base_url/env_key/wire_api) —
        // passed through as `-c model_provider=`. This is how a single agent
        // routes to xAI or a local/hosted OSS model without a new adapter.
        provider: z.string().optional(),
        // Human-authored routing/policy hint shown in the triage prompt when
        // this spec sits in a named pool (e.g. what work the agent is good
        // for). Valid for both clis.
        description: z.string().optional(),
      }),
    ],
    {
      error:
        'expected "codex" or "claude", or { "cli": "codex"|"claude", "model"?: string, "reasoningEffort"?: string, "provider"?: string, "description"?: string }',
    }
  )
  // reasoningEffort maps to codex's `model_reasoning_effort`; claude has a
  // separate model-selection surface, so reject it here instead of ignoring it.
  .refine((spec) => typeof spec === 'string' || !spec.reasoningEffort || spec.cli === 'codex', {
    error: 'reasoningEffort is only supported for the codex cli',
    path: ['reasoningEffort'],
  })
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
export type AgentSpec = z.infer<typeof AgentSpecSchema>
export type Agent = {
  cli: 'codex' | 'claude'
  model?: string
  reasoningEffort?: ReasoningEffort
  provider?: string
  description?: string
}

function defaultNamerAgent(): AgentSpec {
  return {
    cli: 'codex',
    model: 'gpt-5.4-mini',
    reasoningEffort: 'low',
  }
}

export function normAgent(spec: AgentSpec): Agent {
  return typeof spec === 'string' ? { cli: spec } : spec
}

// Which agents play which role. planners is the ensemble (≥2 → cross-critique);
// implementer also runs triage/reconcile/select; reviewer does the adversarial
// review; delivery runs task-local delivery. Each defaults independently when
// omitted.
const AgentMapSchema = z.record(z.string(), AgentSpecSchema)

const AgentsSchema = z.object({
  planners: z.array(AgentSpecSchema).default((): AgentSpec[] => ['codex', 'claude']),
  // DEPRECATED spelling of the lead implementer. The lead now lives in the
  // `implementers` pool under the reserved `default` key; this is honored as a
  // fallback (with a warning) so existing configs don't silently flip to the
  // built-in default. Remove once configs have migrated.
  implementer: AgentSpecSchema.optional(),
  reviewer: AgentSpecSchema.default('claude'),
  delivery: AgentSpecSchema.default('claude'),
  // Read-only router for dynamic research/review/policy selection.
  workforce: AgentSpecSchema.default('claude'),
  // Last-chance read-only strategist before a task truly blocks.
  rescue: AgentSpecSchema.default('claude'),
  // Optional named agent pools the workforce planner can route research scouts
  // and review lenses to, e.g. { "runtime": "claude" }.
  researchers: AgentMapSchema.default({}),
  reviewers: AgentMapSchema.default({}),
  // The implementer pool. The reserved `default` key is the LEAD — it runs
  // triage, reconcile/select, the implement stage, and all fix-pass
  // escalations (falls back to the deprecated `implementer`, then built-in
  // codex). Other entries are named alternatives: triage may route the
  // attempt-0 implement stage to one, and implement/fix prompts offer the
  // whole pool as an in-flight delegation menu. No non-default entries =
  // routing/delegation off.
  implementers: AgentMapSchema.default({}),
  // Cheap, low-latency model used only to turn a raw task intent into a short id.
  // Best-effort callers fall back to the local slug heuristic if this is unavailable.
  // Pin the Codex-recommended fast/lower-cost model and low reasoning so this
  // does not inherit an expensive user default like gpt-5.5 high.
  namer: AgentSpecSchema.default(defaultNamerAgent),
})

const SpecialistPolicySchema = z.object({
  path: z.string().min(1),
  description: z.string().nullable().default(null),
  appliesTo: z.array(z.string().min(1)).default([]),
})

const AskSchema = z
  .object({
    agent: AgentSpecSchema.default('claude'),
  })
  .default((): { agent: AgentSpec } => ({ agent: 'claude' }))

type AgentsConfig = {
  planners: AgentSpec[]
  implementer?: AgentSpec
  reviewer: AgentSpec
  delivery: AgentSpec
  workforce: AgentSpec
  rescue: AgentSpec
  researchers: Record<string, AgentSpec>
  reviewers: Record<string, AgentSpec>
  implementers: Record<string, AgentSpec>
  namer: AgentSpec
}

export type RoleAgents = {
  planners: Agent[]
  implementer: Agent
  reviewer: Agent
  delivery: Agent
  namer: Agent
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
  // Let a read-only agent choose the research scouts, optional review lenses,
  // lens agents, and specialist policies for complex tasks. false falls back to
  // the fixed legacy research/review shape.
  workforce: z.boolean().default(true),
  // Run a read-only rescue strategist before a terminal block. It may authorize
  // one sharper code-fix attempt, ask the human, retry later, or accept the block.
  rescue: z.boolean().default(true),
  // Filesystem/network reach of the implement/fix stages. 'full' (default)
  // removes the sandbox so the implementer can run the repo's real checks
  // (daemonized services, sockets, DBs) DURING implementation — in
  // sandbox-restricted repos the implementer shipped blind and every failure
  // was discovered at the expensive verify gate, the structural cause of the
  // worst fix loops. Factory's threat model already assumes a trusted repo
  // (remediation and delivery run unsandboxed); set 'write' to keep the
  // workspace-write sandbox on implementation anyway.
  implementerAccess: z.enum(['write', 'full']).default('full'),
  // OPTIONAL override for how `factory dispatch` turns a backlog item into a
  // live workstream. The built-in default needs no config: it creates a sibling
  // worktree on a factory/<name> branch and starts a detached
  // `factory run --until-done` in it, logging under $FACTORY_HOME/logs/. Set a
  // custom spawn command to route through your own tooling instead (tmux
  // windows, custom worktree layout): it runs once per item via `bash -lc` with
  // FACTORY_INTENT / FACTORY_NAME / FACTORY_VERIFY in its environment; exit 0
  // removes the item from the backlog.
  dispatch: z
    .object({
      spawn: z.string().min(1),
    })
    .nullable()
    .default(null),
  // The earned-autonomy dial for delivery confirmation. When set, an
  // auto-selected side-effecting delivery ($pr/$ship) no longer pauses for
  // human confirmation IF the repo's recent telemetry has earned it: at least
  // `minTasks` recent terminal tasks with a first-pass yield (done, zero fix
  // retries) at or above `minFirstPassYield`. Autonomy expands exactly as fast
  // as the numbers justify and contracts automatically when they dip. null
  // (default) = always confirm side-effecting deliveries.
  autoShip: z
    .object({
      minFirstPassYield: z.number().min(0).max(1),
      minTasks: z.number().int().positive(),
    })
    .nullable()
    .default(null),
  // Auto-accept recommended answers: when a needs-input task's questions ALL
  // carry a recommended answer and nobody has replied for this many minutes, the
  // loop proceeds with the recommendations (recorded as an explicit, reviewable
  // answer). null (default) = never auto-accept — asking is a quality instrument
  // and silence may mean the human wants to weigh in; opt in deliberately.
  autoAcceptAfterMinutes: z.number().int().positive().nullable().default(null),
  // User-authored standing policy files the workforce planner may attach to
  // specific research scouts or review lenses. Relative paths resolve from root.
  specialists: z.record(z.string(), SpecialistPolicySchema).default({}),
  // Lifecycle hooks: event name → shell commands run when factory reaches that
  // event (see hooks.ts). Lets the surrounding environment react — tmux, desktop
  // notifications, dashboards — without factory knowing about it. Concatenated
  // across the cascade rather than closest-wins (see loadConfig).
  hooks: HookMapSchema.default({}),
  // Which agents fill each role. Omit to use the defaults below.
  agents: AgentsSchema.default(
    (): AgentsConfig => ({
      planners: ['codex', 'claude'],
      reviewer: 'claude',
      delivery: 'claude',
      workforce: 'claude',
      rescue: 'claude',
      researchers: {},
      reviewers: {},
      implementers: {},
      namer: defaultNamerAgent(),
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

// An unknown key (a typo, or one a factory upgrade removed) is not worth aborting
// the whole run over: the rest of the file is still valid, and the schema drops
// unknown keys anyway (z.object strips them). So we warn and carry on. Throwing
// here was especially bad mid-`add`, where it discarded a task intent the user had
// just composed in their editor. Malformed *values* still fail — only unknown keys
// are downgraded to a warning.
const KNOWN_CONFIG_KEYS = new Set(Object.keys(ConfigSchema.shape))

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

export function guidanceDir(): string {
  return `${factoryHome()}/guidance`
}

export function sessionsDir(): string {
  return `${factoryHome()}/sessions`
}

// Machine-wide delivery skills, available in every repo (a repo's .skills/
// entries override same-named globals).
export function globalSkillsDir(): string {
  return `${factoryHome()}/skills`
}

// Where the built-in dispatcher writes each spawned workstream's run output.
export function dispatchLogsDir(): string {
  return `${factoryHome()}/logs`
}

// Each session (per-worktree) state dir records which worktree it belongs to,
// so `factory gc` can tell that the worktree was torn down. The path→key
// encoding is lossy (dashes), so the reverse mapping must be stored, not derived.
export function worktreeMarkerPath(stateDir: string): string {
  return `${stateDir}/worktree.json`
}

export async function writeWorktreeMarker(stateDir: string, root: string): Promise<void> {
  const path = worktreeMarkerPath(stateDir)
  if (!(await Bun.file(path).exists())) {
    await Bun.write(
      path,
      `${JSON.stringify({ root })}
`
    )
  }
}

// The repo-identity config layer: per-repo, machine-local, outside the repo —
// e.g. "implementerAccess: full for yc-code on this box" without committing
// anything or repeating it per worktree. Sits between the global base and the
// .factory.json cascade. null outside a git repo.
export async function repoConfigFile(root: string): Promise<string | null> {
  try {
    const origin = await originUrl(root)
    const mainRoot = await mainWorktreeRoot(root)
    return `${factoryHome()}/repos/${repoKey(origin, mainRoot)}/config.json`
  } catch {
    return null
  }
}

// Candidate config files in priority order, lowest first: the global base, the
// repo-identity layer, then each ancestor from the filesystem root down to the
// worktree (closest wins).
async function configCandidates(root: string): Promise<string[]> {
  const global = globalConfigFile()
  const repo = await repoConfigFile(root)
  const ancestors = ancestorDirs(root)
    .reverse()
    .map((dir) => `${dir}/${CONFIG_NAME}`)
  return [...(global ? [global] : []), ...(repo ? [repo] : []), ...ancestors]
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `agents` and `specialists` merge PER KEY across the cascade instead of
// closest-file-wins for the whole object. A worktree override like
// {"agents": {"implementer": "codex"}} used to silently reset every OTHER role
// (reviewer, planners, namer) to defaults — the single worst config footgun.
// Within `agents`, the nested researcher/reviewer/implementer pools merge per
// key too.
function mergeObjectKey(base: unknown, incoming: unknown, nestedMergeKeys: string[] = []): unknown {
  if (!isPlainObject(base) || !isPlainObject(incoming)) {
    return incoming
  }
  const merged: Record<string, unknown> = { ...base, ...incoming }
  for (const key of nestedMergeKeys) {
    if (isPlainObject(base[key]) && isPlainObject(incoming[key])) {
      merged[key] = { ...base[key], ...incoming[key] }
    }
  }
  return merged
}

// The config files that actually exist, closest (highest priority) first.
export async function configSources(root: string): Promise<string[]> {
  const found: string[] = []
  for (const path of await configCandidates(root)) {
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
  for (const path of await configCandidates(root)) {
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
    for (const key of Object.keys(raw)) {
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        log.warn(`${path}: unknown config key "${key}" — ignoring`)
      }
    }

    let hooks: Record<string, string[]> | null = null
    if ('hooks' in raw) {
      const result = HookMapSchema.safeParse(raw.hooks)
      if (!result.success) {
        throw new ConfigError(formatConfigError(result.error, [path]))
      }
      hooks = result.data
    }

    const prior = merged
    merged = { ...merged, ...raw }
    if (hooks) {
      merged['hooks'] = mergeHooks(prior['hooks'] as Record<string, string[]> | undefined, hooks)
    }
    if ('agents' in raw) {
      merged['agents'] = mergeObjectKey(prior['agents'], raw.agents, [
        'researchers',
        'reviewers',
        'implementers',
      ])
    }
    if ('specialists' in raw) {
      merged['specialists'] = mergeObjectKey(prior['specialists'], raw.specialists)
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
  // Repo-level state dir (keyed by repo identity — normalized origin), shared
  // across the repo's worktrees — holds the telemetry db and LESSONS (the meta
  // loop), so both accumulate across worktrees instead of resetting per branch.
  repoStateDir: string
  metricsPath: string
  // Machine-specific layer of repo state: the environment playbook. Provisioning
  // steps and known quirks WITH their fixes, written by the remediation doctor,
  // read before every diagnosis. Repo×machine because its content (container
  // memory limits, sockets, local DB names) is not portable across hosts.
  envPlaybookPath: string
}

function resolveAgents(config: Config): RoleAgents {
  const a = config.agents
  // The lead implementer is the pool's reserved `default` entry. The legacy
  // top-level `implementer` is honored behind it so an un-migrated config keeps
  // its chosen agent instead of silently flipping to the built-in default —
  // config keys unknown to older schemas are warn-and-ignore, so removal
  // without a fallback would be a silent behavior change.
  const lead = a.implementers['default'] ?? a.implementer ?? 'codex'
  if (a.implementer !== undefined) {
    log.warn(
      a.implementers['default'] !== undefined
        ? 'agents.implementer is ignored: agents.implementers.default takes precedence'
        : 'agents.implementer is deprecated: move it to agents.implementers.default'
    )
  }
  return {
    planners: a.planners.map(normAgent),
    implementer: normAgent(lead),
    reviewer: normAgent(a.reviewer),
    delivery: normAgent(a.delivery),
    namer: normAgent(a.namer),
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

// The repo is a first-class concept, identified by its origin remote rather than
// where a clone happens to live on disk — so the same repo shares one body of
// repo-level state (lessons, metrics, evals, delivery history) across hosts and
// checkout paths. Normalizes the common URL shapes to one canonical form:
//   https://user:tok@GitHub.com/evansolomon/factory.git
//   ssh://git@github.com/evansolomon/factory
//   git@github.com:evansolomon/factory.git
// all → github.com/evansolomon/factory. Host is case-insensitive (lowered);
// the path is preserved as-is apart from the trailing `.git`.
export function normalizeOrigin(url: string): string | null {
  let rest = url.trim()
  const protocol = rest.match(/^[a-z][a-z0-9+.-]*:\/\//i)
  if (protocol) {
    rest = rest.slice(protocol[0].length)
  } else {
    // scp-like syntax: [user@]host:path
    const scp = rest.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/)
    if (scp?.[1] && scp[2]) {
      rest = `${scp[1]}/${scp[2]}`
    }
  }
  // credentials, port
  rest = rest.replace(/^[^@/]+@/, '')
  const slash = rest.indexOf('/')
  if (slash <= 0) {
    return null
  }
  const host = rest.slice(0, slash).replace(/:\d+$/, '').toLowerCase()
  const path = rest
    .slice(slash + 1)
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  if (!host || !path) {
    return null
  }
  return `${host}/${path}`
}

// Filesystem key for a repo's state dir under <base>/repos/. Derived from the
// normalized origin; falls back to the main worktree's path key for repos with
// no origin remote.
export function repoKey(origin: string | null, mainRoot: string): string {
  const normalized = origin ? normalizeOrigin(origin) : null
  return normalized ? normalized.replace(/\//g, '-') : worktreeKey(mainRoot)
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

// Repo-level state (lessons, metrics, eval candidates, delivery history, the env
// playbook) is keyed by repo identity, not checkout path. An in-repo `dir`
// (relative) keeps repo state in the main worktree as before — it's committed,
// so it travels with the repo already. Otherwise state lives under
// <base>/repos/<repo-key>, where <base> is the explicit absolute/~ `dir` or the
// factory home.
function resolveRepoStateDir(mainRoot: string, config: Config, origin: string | null): string {
  const dir = config.dir
  if (dir && !dir.startsWith('/') && !dir.startsWith('~')) {
    return `${mainRoot}/${dir}`
  }
  const base = dir ? expandTilde(dir) : factoryHome()
  return `${base}/repos/${repoKey(origin, mainRoot)}`
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
  const repoStateDir = resolveRepoStateDir(mainRoot, mainConfig, await originUrl(mainRoot))
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
    envPlaybookPath: `${repoStateDir}/env/${hostname()}.md`,
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
  const repoStateDir = resolveRepoStateDir(mainRoot, config, await originUrl(mainRoot))
  return {
    mainRoot,
    config,
    backlogDir: `${repoStateDir}/backlog`,
    metricsPath: `${repoStateDir}/metrics.db`,
    agents: resolveAgents(config),
  }
}
