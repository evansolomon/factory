import { GUIDANCE_STAGE_VALUES } from './guidance.ts'
import { TaskComplexitySchema } from './task.ts'

export type CompletionChoice = {
  name: string
  description: string
}

// Where a flag value or positional argument gets its completion candidates.
// Descriptors, not functions — this module stays import-light because it feeds
// startup-sensitive command checks (auto-upgrade); the resolver that turns a
// descriptor into candidates lives in complete.ts.
export type ValueSource =
  | { kind: 'static'; choices: readonly CompletionChoice[] }
  | { kind: 'task-id' }
  | { kind: 'show-step'; task: 'latest' | 'arg1' }
  | { kind: 'lesson-id' }
  | { kind: 'backlog-id' }
  | { kind: 'eval-case' }
  // directive ⇒ insert the canonical `$name` delivery-directive form
  | { kind: 'skill-name'; insert: 'bare' | 'directive' }
  | { kind: 'none' }

export type OptionSpec = {
  name: string // canonical form: '--message', '--limit'
  alias?: string // '-m'
  description: string
  value?: ValueSource // absent ⇒ boolean flag
  equals?: boolean // also accepts/completes --name=value
  repeat?: boolean // may appear multiple times (lessons edit --stage)
  // Consumes ALL remaining tokens as its value (--verify); completion offers
  // nothing after it.
  tail?: boolean
}

export type PositionalSpec = {
  name: string // display only ('task-id', 'intent…')
  sources: readonly ValueSource[]
  variadic?: boolean // trailing freeform
}

export type SubcommandSpec = {
  name: string
  description: string
  options?: readonly OptionSpec[]
  positionals?: readonly PositionalSpec[]
  subcommands?: readonly SubcommandSpec[]
}

export type CommandSpec = SubcommandSpec & { autoUpgrade: boolean; hidden?: boolean }

const NONE = { kind: 'none' } as const

const TASK_ID = { kind: 'task-id' } as const

const TASK_ID_POSITIONAL = { name: 'task-id', sources: [TASK_ID] } as const

export const COMPLEXITY_CHOICES = TaskComplexitySchema.options.map((name) => ({
  name,
  description: `${name} task`,
}))

// Mirrors InteractiveAgent in agent-session.ts; kept local to avoid importing the
// session launcher path into metadata used by startup-sensitive command checks.
export const AGENT_CHOICES = [
  { name: 'codex', description: 'Use Codex' },
  { name: 'claude', description: 'Use Claude' },
] as const

// The message grammar shared by the human-input commands
// (retry/resume/answer/feedback/correct/close). Parsed by input.ts.
export const MESSAGE_OPTIONS = [
  {
    name: '--message',
    alias: '-m',
    description: 'Provide the message inline',
    value: NONE,
    equals: true,
  },
  { name: '--edit', description: 'Compose the message in $EDITOR' },
] as const satisfies readonly OptionSpec[]

const guidanceScopeChoices = [
  { name: 'global', description: 'Global learned lessons' },
  { name: 'repo', description: 'Current repo learned lessons' },
] as const

const guidanceStageChoices = GUIDANCE_STAGE_VALUES.map((name) => ({
  name,
  description: `${name} stage`,
}))

const GUIDANCE_SCOPE_SOURCE = { kind: 'static', choices: guidanceScopeChoices } as const
const GUIDANCE_STAGE_SOURCE = { kind: 'static', choices: guidanceStageChoices } as const

export const LESSONS_LIST_OPTIONS = [
  { name: '--all', description: 'Include deleted learned lessons' },
  { name: '--scope', description: 'Filter by scope', value: GUIDANCE_SCOPE_SOURCE, equals: true },
  { name: '--stage', description: 'Filter by stage', value: GUIDANCE_STAGE_SOURCE, equals: true },
] as const satisfies readonly OptionSpec[]

export const LESSONS_CURATE_OPTIONS = [
  { name: '--dry-run', description: 'Inspect curation without writing' },
  {
    name: '--min-cluster',
    description: 'Minimum similar candidates before promotion',
    value: NONE,
    equals: true,
  },
  {
    name: '--eval-case',
    description: 'Gate with matching eval case files only',
    value: { kind: 'eval-case' },
    equals: true,
  },
  { name: '--keep-evals', description: 'Keep throwaway eval replay worktrees' },
] as const satisfies readonly OptionSpec[]

export const LESSONS_EDIT_OPTIONS = [
  {
    name: '--message',
    alias: '-m',
    description: 'Provide the lesson text inline',
    value: NONE,
    equals: true,
  },
  { name: '--edit', description: 'Compose the lesson text in $EDITOR' },
  {
    name: '--scope',
    description: 'Set the lesson scope',
    value: GUIDANCE_SCOPE_SOURCE,
    equals: true,
  },
  {
    name: '--stage',
    description: 'Set a lesson stage',
    value: GUIDANCE_STAGE_SOURCE,
    equals: true,
    repeat: true,
  },
] as const satisfies readonly OptionSpec[]

const LESSON_ID_POSITIONAL = { name: 'lesson-id', sources: [{ kind: 'lesson-id' }] } as const

// The options parseAddOptions scans for. `--edit` is deliberately NOT here: it
// is recognized by resolveIntent (even inside the --verify tail), so it must
// flow through parseAddOptions as an intent token, not be extracted as a flag.
export const ADD_PARSE_OPTIONS = [
  { name: '--raw', description: 'Skip sharpening for newly queued work' },
  { name: '--trivial', description: 'Declare the new task trivial' },
  {
    name: '--complexity',
    description: 'Declare the new task complexity',
    value: { kind: 'static', choices: COMPLEXITY_CHOICES },
  },
  { name: '--allow-dirty', description: 'Start a new task on a dirty worktree deliberately' },
  { name: '--name', description: 'Name the task directly (skips the AI namer)', value: NONE },
  {
    name: '--verify',
    description: 'Set a verify command for newly queued work',
    value: NONE,
    tail: true,
  },
] as const satisfies readonly OptionSpec[]

export const RUN_OPTIONS = [
  { name: '--once', description: 'Do one ready task, then exit' },
  { name: '--until-done', description: 'Exit when the workstream task completes or blocks' },
  { name: '--no-prompt', description: 'Do not prompt inline for answers' },
] as const satisfies readonly OptionSpec[]

const EDIT_OPTION = { name: '--edit', description: 'Compose the intent in $EDITOR' } as const

// The full `backlog add` grammar, scanned at dispatch: --verify consumes the
// rest of the line as its tail; --raw and --edit are recognized (and stripped)
// anywhere, including inside that tail — the historical rule.
export const BACKLOG_ADD_OPTIONS = [
  { name: '--raw', description: 'Skip sharpening for the backlog entry' },
  {
    name: '--verify',
    description: 'Set a verify command for the backlog entry',
    value: NONE,
    tail: true,
  },
  EDIT_OPTION,
] as const satisfies readonly OptionSpec[]

export const SESSION_OPTIONS = [
  {
    name: '--agent',
    description: 'Choose the interactive agent',
    value: { kind: 'static', choices: AGENT_CHOICES },
    equals: true,
  },
] as const satisfies readonly OptionSpec[]

export const DECK_OPTIONS = [
  { name: '--url', description: 'Print the deck file URL instead of opening a browser' },
] as const satisfies readonly OptionSpec[]

export const DELIVERY_OPTIONS = [
  { name: '--task', description: 'Target a specific task', value: TASK_ID },
] as const satisfies readonly OptionSpec[]

// Flags mirror the object AgentSpec fields; the conductor renders these
// commands from validated pool entries (delegate.ts), so no value completion.
export const DELEGATE_OPTIONS = [
  {
    name: '--cli',
    description: 'Agent CLI to run',
    value: { kind: 'static', choices: AGENT_CHOICES },
    equals: true,
  },
  { name: '--model', description: 'Model override', value: NONE, equals: true },
  { name: '--effort', description: 'Agent effort override', value: NONE, equals: true },
  { name: '--reasoning-effort', description: 'Codex reasoning effort', value: NONE, equals: true },
  { name: '--provider', description: 'Codex model provider', value: NONE, equals: true },
  {
    name: '--usage-file',
    description: 'Append a JSON token-usage record to this file',
    value: NONE,
    equals: true,
  },
] as const satisfies readonly OptionSpec[]

export const DISPATCH_OPTIONS = [
  { name: '--dry-run', description: 'Show what would be dispatched without spawning' },
  { name: '--limit', description: 'Dispatch at most N backlog items', value: NONE },
] as const satisfies readonly OptionSpec[]

export const HARVEST_OPTIONS = [
  { name: '--all', description: 'Re-check previously harvested tasks too' },
] as const satisfies readonly OptionSpec[]

export const GC_OPTIONS = [
  { name: '--dry-run', description: 'Show what would be removed without deleting' },
] as const satisfies readonly OptionSpec[]

export const REPORT_OPTIONS = [
  { name: '--all', description: 'Roll up telemetry across the repo' },
] as const satisfies readonly OptionSpec[]

export const EVALS_RUN_OPTIONS = [
  { name: '--keep', description: 'Keep throwaway eval replay worktrees' },
] as const satisfies readonly OptionSpec[]

export const SKILLS_EDIT_OPTIONS = [
  { name: '--repo', description: 'Edit the repo-identity skill layer' },
  { name: '--global', description: 'Edit the global skill layer' },
  { name: '--committed', description: 'Edit the committed in-repo skill layer' },
] as const satisfies readonly OptionSpec[]

export const CONFIG_EDIT_OPTIONS = [
  { name: '--global', description: 'Edit global config' },
  { name: '--repo', description: 'Edit the repo-identity config layer' },
  { name: '--worktree', description: 'Edit worktree config' },
  { name: '--repo-parent', description: 'Edit repo-parent config' },
  { name: '--dir', description: 'Edit config in a specific directory', value: NONE },
] as const satisfies readonly OptionSpec[]

export const ASK_OPTIONS = [
  { name: '--print', description: 'Print one answer and exit' },
] as const satisfies readonly OptionSpec[]

// Decorations for well-known step names; the candidate set itself is always the
// task dir's *.activity.jsonl files (see complete.ts), never this list.
export const SHOW_STEP_DESCRIPTIONS: Record<string, string> = {
  implement: 'Implementation activity',
  review: 'Consolidated review output',
  verify: 'Verification output',
  'plan.codex': 'Codex plan activity',
  'plan.claude': 'Claude plan activity',
}

const INTENT_POSITIONAL = { name: 'intent…', sources: [NONE], variadic: true } as const

export const COMMANDS = [
  {
    name: 'add',
    description: 'Tell this factory/workstream something',
    autoUpgrade: true,
    options: [...ADD_PARSE_OPTIONS, EDIT_OPTION],
    positionals: [INTENT_POSITIONAL],
  },
  {
    name: 'run',
    description: 'Work the stream',
    autoUpgrade: true,
    options: RUN_OPTIONS,
  },
  {
    name: 'retry',
    description: 'Pick a blocked or interrupted task back up',
    autoUpgrade: true,
    options: MESSAGE_OPTIONS,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'feedback',
    description: 'Record human critique on existing task work',
    autoUpgrade: true,
    options: MESSAGE_OPTIONS,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'correct',
    description: 'Record your manual fix of a blocked task',
    autoUpgrade: true,
    options: MESSAGE_OPTIONS,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'close',
    description: 'Terminally close a parked task without a commit',
    autoUpgrade: true,
    options: MESSAGE_OPTIONS,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'backlog',
    description: 'Experimental repo-level backlog of vetted intents',
    autoUpgrade: true,
    subcommands: [
      {
        name: 'add',
        description: 'Add an intent to the backlog',
        options: BACKLOG_ADD_OPTIONS,
        positionals: [INTENT_POSITIONAL],
      },
      {
        name: 'rm',
        description: 'Remove a backlog entry',
        positionals: [{ name: 'backlog-id', sources: [{ kind: 'backlog-id' }] }],
      },
    ],
  },
  {
    name: 'dispatch',
    description: 'Spawn one workstream per backlog item',
    autoUpgrade: true,
    options: DISPATCH_OPTIONS,
  },
  {
    name: 'config',
    description: 'Show or edit effective config',
    autoUpgrade: true,
    subcommands: [
      {
        name: 'edit',
        description: 'Open a config file in $EDITOR',
        options: CONFIG_EDIT_OPTIONS,
        positionals: [{ name: 'dir', sources: [NONE] }],
      },
    ],
  },
  { name: 'status', description: 'Catch-up dashboard', autoUpgrade: true },
  {
    name: 'ask',
    description: 'Interactive Q&A over saved task state',
    autoUpgrade: true,
    options: ASK_OPTIONS,
    positionals: [TASK_ID_POSITIONAL, { name: 'question…', sources: [NONE], variadic: true }],
  },
  {
    name: 'session',
    description: 'Open an interactive agent session from task artifacts',
    autoUpgrade: true,
    options: SESSION_OPTIONS,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'codex',
    description: 'Open a Codex session from task artifacts',
    autoUpgrade: true,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'claude',
    description: 'Open a Claude session from task artifacts',
    autoUpgrade: true,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'show',
    description: 'Drill into one task or step activity',
    autoUpgrade: true,
    positionals: [
      // A lone first arg may be a task id OR a step of the latest task,
      // mirroring printShow's lone-arg-is-a-step semantics (view.ts).
      { name: 'task-or-step', sources: [TASK_ID, { kind: 'show-step', task: 'latest' }] },
      { name: 'step', sources: [{ kind: 'show-step', task: 'arg1' }] },
    ],
  },
  {
    name: 'deck',
    description: 'Open the visual one-page brief for a done task',
    autoUpgrade: true,
    options: DECK_OPTIONS,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'delivery',
    description: 'Show or set the task-local completion action',
    autoUpgrade: true,
    options: DELIVERY_OPTIONS,
    positionals: [
      {
        name: 'action',
        sources: [
          {
            kind: 'static',
            choices: [{ name: 'none', description: 'Stop after the local commit' }],
          },
          { kind: 'skill-name', insert: 'directive' },
        ],
      },
      { name: 'policy…', sources: [NONE], variadic: true },
    ],
  },
  {
    name: 'report',
    description: 'Telemetry roll-up',
    autoUpgrade: true,
    options: REPORT_OPTIONS,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'harvest',
    description: 'Harvest post-ship rework and MR discussion for done tasks',
    autoUpgrade: true,
    options: HARVEST_OPTIONS,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'gc',
    description: 'Prune session state for worktrees that no longer exist',
    autoUpgrade: true,
    options: GC_OPTIONS,
  },
  {
    name: 'skills',
    description: 'Manage delivery skills',
    autoUpgrade: true,
    subcommands: [
      { name: 'list', description: 'List effective delivery skills' },
      {
        name: 'edit',
        description: 'Edit a delivery skill',
        options: SKILLS_EDIT_OPTIONS,
        positionals: [{ name: 'skill-name', sources: [{ kind: 'skill-name', insert: 'bare' }] }],
      },
    ],
  },
  {
    name: 'evals',
    description: 'Replay harvested eval candidates against the current build',
    autoUpgrade: true,
    subcommands: [
      { name: 'list', description: 'List captured eval candidates' },
      {
        name: 'run',
        description: 'Replay eval candidates',
        options: EVALS_RUN_OPTIONS,
        positionals: [{ name: 'case', sources: [{ kind: 'eval-case' }] }],
      },
    ],
  },
  {
    name: 'lessons',
    description: 'Learned lessons, legacy lessons, and raw candidates',
    autoUpgrade: true,
    subcommands: [
      { name: 'list', description: 'List learned lessons', options: LESSONS_LIST_OPTIONS },
      {
        name: 'show',
        description: 'Show a learned lesson',
        positionals: [LESSON_ID_POSITIONAL],
      },
      {
        name: 'rm',
        description: 'Remove a learned lesson',
        positionals: [LESSON_ID_POSITIONAL],
      },
      {
        name: 'curate',
        description: 'Drain recurring lesson candidates through the eval gate',
        options: LESSONS_CURATE_OPTIONS,
      },
      {
        name: 'edit',
        description: 'Edit a learned lesson',
        options: LESSONS_EDIT_OPTIONS,
        positionals: [LESSON_ID_POSITIONAL],
      },
    ],
  },
  { name: 'version', description: 'Print the current CLI version', autoUpgrade: false },
  {
    name: 'upgrade',
    description: 'Update factory to the latest GitHub release',
    autoUpgrade: false,
  },
  {
    name: 'completion',
    description: 'Print a shell completion script',
    autoUpgrade: false,
    subcommands: [{ name: 'zsh', description: 'Print zsh completion script' }],
  },
  { name: 'help', description: 'Show help', autoUpgrade: false },
  {
    name: 'answer',
    description: 'Deprecated alias for answering a task',
    autoUpgrade: true,
    hidden: true,
    options: MESSAGE_OPTIONS,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'resume',
    description: 'Deprecated alias for retry',
    autoUpgrade: true,
    hidden: true,
    options: MESSAGE_OPTIONS,
    positionals: [TASK_ID_POSITIONAL],
  },
  {
    name: 'delegate',
    description: 'Run a one-shot delegated agent for an implement stage (internal)',
    autoUpgrade: false,
    hidden: true,
    options: DELEGATE_OPTIONS,
  },
  {
    name: '__complete',
    description: 'Shell completion helper (internal)',
    autoUpgrade: false,
    hidden: true,
  },
] as const satisfies readonly CommandSpec[]

export type CommandName = (typeof COMMANDS)[number]['name']

type CommandFor<N extends CommandName> = Extract<(typeof COMMANDS)[number], { name: N }>

export type SubcommandNames<N extends CommandName> =
  CommandFor<N> extends {
    subcommands: readonly (infer S extends { name: string })[]
  }
    ? S['name']
    : never

// Literal-preserving lookup — deliberately NOT a Map<string, CommandSpec>,
// which would widen spec.name to string and break HANDLERS[spec.name] indexing.
export function resolveCommand(name: string): (typeof COMMANDS)[number] | undefined {
  return COMMANDS.find((command) => command.name === name)
}

export const AUTO_UPGRADE_COMMAND_NAMES: readonly CommandName[] = COMMANDS.filter(
  (command) => command.autoUpgrade
).map((command) => command.name)

export function activeCommandChoices(): readonly CompletionChoice[] {
  return COMMANDS.filter((command: CommandSpec) => !command.hidden).map(
    ({ name, description }) => ({ name, description })
  )
}
