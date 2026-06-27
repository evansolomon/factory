import { GUIDANCE_STAGE_VALUES } from './guidance.ts'
import { TaskComplexitySchema } from './task.ts'

export type CompletionChoice = {
  name: string
  description: string
}

export type CompletionOption = CompletionChoice & {
  values?: readonly CompletionChoice[]
}

export type CompletionSubcommand = CompletionChoice & {
  options?: readonly CompletionOption[]
  subcommands?: readonly CompletionSubcommand[]
}

export type CommandSpec = CompletionChoice & {
  autoUpgrade: boolean
  hidden?: boolean
  options?: readonly CompletionOption[]
  subcommands?: readonly CompletionSubcommand[]
}

const taskComplexityChoices = TaskComplexitySchema.options.map((name) => ({
  name,
  description: `${name} task`,
}))

// Mirrors InteractiveAgent in agent-session.ts; kept local to avoid importing the
// session launcher path into metadata used by startup-sensitive command checks.
const agentChoices = [
  { name: 'codex', description: 'Use Codex' },
  { name: 'claude', description: 'Use Claude' },
] as const

const messageOptions = [
  { name: '-m', description: 'Provide the message inline' },
  { name: '--message', description: 'Provide the message inline' },
  { name: '--message=', description: 'Provide the message inline' },
  { name: '--edit', description: 'Compose the message in $EDITOR' },
] as const

const guidanceScopeChoices = [
  { name: 'global', description: 'Global learned lessons' },
  { name: 'repo', description: 'Current repo learned lessons' },
] as const

const guidanceStageChoices = GUIDANCE_STAGE_VALUES.map((name) => ({
  name,
  description: `${name} stage`,
}))

const lessonsSubcommands = [
  {
    name: 'list',
    description: 'List learned lessons',
    options: [
      { name: '--all', description: 'Include deleted learned lessons' },
      { name: '--scope', description: 'Filter by scope', values: guidanceScopeChoices },
      { name: '--stage', description: 'Filter by stage', values: guidanceStageChoices },
    ],
  },
  { name: 'show', description: 'Show a learned lesson' },
  { name: 'rm', description: 'Remove a learned lesson' },
  {
    name: 'edit',
    description: 'Edit a learned lesson',
    options: [
      { name: '-m', description: 'Provide the lesson text inline' },
      { name: '--message', description: 'Provide the lesson text inline' },
      { name: '--message=', description: 'Provide the lesson text inline' },
      { name: '--edit', description: 'Compose the lesson text in $EDITOR' },
      { name: '--scope', description: 'Set the lesson scope', values: guidanceScopeChoices },
      { name: '--stage', description: 'Set a lesson stage', values: guidanceStageChoices },
    ],
  },
] as const

export const TASK_CONFIG_KEY_CHOICES = [
  { name: 'on-complete', description: 'Task-local delivery instructions' },
] as const

const taskConfigSubcommands = [
  {
    name: 'set',
    description: 'Set a task-local config value',
    options: [{ name: '--task', description: 'Target a specific task' }],
    subcommands: TASK_CONFIG_KEY_CHOICES,
  },
  {
    name: 'get',
    description: 'Show a task-local config value',
    options: [{ name: '--task', description: 'Target a specific task' }],
    subcommands: TASK_CONFIG_KEY_CHOICES,
  },
  {
    name: 'unset',
    description: 'Disable a task-local config value',
    options: [{ name: '--task', description: 'Target a specific task' }],
    subcommands: TASK_CONFIG_KEY_CHOICES,
  },
  {
    name: 'inherit',
    description: 'Clear the task-local override',
    options: [{ name: '--task', description: 'Target a specific task' }],
    subcommands: TASK_CONFIG_KEY_CHOICES,
  },
  {
    name: 'edit',
    description: 'Open a config file in $EDITOR',
    options: [
      { name: '--global', description: 'Edit global config' },
      { name: '--worktree', description: 'Edit worktree config' },
      { name: '--repo-parent', description: 'Edit repo-parent config' },
      { name: '--dir', description: 'Edit config in a specific directory' },
    ],
  },
] as const

export const SHOW_STEP_CHOICES = [
  { name: 'implement', description: 'Implementation activity' },
  { name: 'review', description: 'Consolidated review output' },
  { name: 'verify', description: 'Verification output' },
  { name: 'plan.codex', description: 'Codex plan activity' },
  { name: 'plan.claude', description: 'Claude plan activity' },
] as const

export const COMPLETION_SHELL_CHOICES = [
  { name: 'zsh', description: 'Print zsh completion script' },
] as const

export const COMPLEXITY_CHOICES = taskComplexityChoices
export const AGENT_CHOICES = agentChoices

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'add',
    description: 'Tell this factory/workstream something',
    autoUpgrade: true,
    options: [
      { name: '--raw', description: 'Skip sharpening for newly queued work' },
      { name: '--trivial', description: 'Declare the new task trivial' },
      {
        name: '--complexity',
        description: 'Declare the new task complexity',
        values: COMPLEXITY_CHOICES,
      },
      { name: '--verify', description: 'Set a verify command for newly queued work' },
      { name: '--edit', description: 'Compose the intent in $EDITOR' },
    ],
  },
  {
    name: 'run',
    description: 'Work the stream',
    autoUpgrade: true,
    options: [
      { name: '--once', description: 'Do one ready task, then exit' },
      { name: '--drain', description: 'Work until the stream is idle, then exit' },
      { name: '--no-prompt', description: 'Do not prompt inline for answers' },
    ],
  },
  {
    name: 'retry',
    description: 'Pick a blocked or interrupted task back up',
    autoUpgrade: true,
    options: messageOptions,
  },
  {
    name: 'feedback',
    description: 'Record human critique on existing task work',
    autoUpgrade: true,
    options: messageOptions,
  },
  {
    name: 'correct',
    description: 'Record your manual fix of a blocked task',
    autoUpgrade: true,
    options: messageOptions,
  },
  {
    name: 'backlog',
    description: 'Experimental repo-level backlog of vetted intents',
    autoUpgrade: true,
    subcommands: [
      {
        name: 'add',
        description: 'Add an intent to the backlog',
        options: [
          { name: '--raw', description: 'Skip sharpening for the backlog entry' },
          { name: '--verify', description: 'Set a verify command for the backlog entry' },
          { name: '--edit', description: 'Compose the intent in $EDITOR' },
        ],
      },
      { name: 'rm', description: 'Remove a backlog entry' },
    ],
  },
  {
    name: 'config',
    description: 'Show or edit effective config',
    autoUpgrade: true,
    subcommands: taskConfigSubcommands,
  },
  { name: 'status', description: 'Catch-up dashboard', autoUpgrade: true },
  {
    name: 'ask',
    description: 'Interactive Q&A over saved task state',
    autoUpgrade: true,
    options: [{ name: '--print', description: 'Print one answer and exit' }],
  },
  {
    name: 'session',
    description: 'Open an interactive agent session from task artifacts',
    autoUpgrade: true,
    options: [
      { name: '--agent', description: 'Choose the interactive agent', values: AGENT_CHOICES },
      { name: '--agent=', description: 'Choose the interactive agent', values: AGENT_CHOICES },
    ],
  },
  { name: 'codex', description: 'Open a Codex session from task artifacts', autoUpgrade: true },
  { name: 'claude', description: 'Open a Claude session from task artifacts', autoUpgrade: true },
  {
    name: 'show',
    description: 'Drill into one task or step activity',
    autoUpgrade: true,
    subcommands: SHOW_STEP_CHOICES,
  },
  {
    name: 'deck',
    description: 'Open the visual one-page brief for a done task',
    autoUpgrade: true,
    options: [
      {
        name: '--url',
        description: 'Print the deck file URL instead of opening a browser',
      },
    ],
  },
  { name: 'report', description: 'Telemetry roll-up', autoUpgrade: true },
  {
    name: 'lessons',
    description: 'Learned lessons, legacy lessons, and raw candidates',
    autoUpgrade: true,
    subcommands: lessonsSubcommands,
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
    subcommands: COMPLETION_SHELL_CHOICES,
  },
  { name: 'help', description: 'Show help', autoUpgrade: false },
  {
    name: 'answer',
    description: 'Deprecated alias for answering a task',
    autoUpgrade: true,
    hidden: true,
    options: messageOptions,
  },
  {
    name: 'resume',
    description: 'Deprecated alias for retry',
    autoUpgrade: true,
    hidden: true,
    options: messageOptions,
  },
]

const AUTO_UPGRADE_COMMAND_ORDER = [
  'add',
  'backlog',
  'run',
  'answer',
  'feedback',
  'retry',
  'resume',
  'correct',
  'status',
  'ask',
  'session',
  'codex',
  'claude',
  'config',
  'show',
  'deck',
  'lessons',
  'report',
] as const

const commandByName = new Map(COMMANDS.map((command) => [command.name, command]))

export const AUTO_UPGRADE_COMMAND_NAMES: readonly string[] = AUTO_UPGRADE_COMMAND_ORDER.map(
  (name) => {
    const command = commandByName.get(name)
    if (!command?.autoUpgrade) {
      throw new Error(`invalid auto-upgrade command metadata: ${name}`)
    }
    return name
  }
)

export function activeCommandChoices(): readonly CompletionChoice[] {
  return COMMANDS.filter((command) => !command.hidden).map(({ name, description }) => ({
    name,
    description,
  }))
}
