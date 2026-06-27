import {
  AGENT_CHOICES,
  activeCommandChoices,
  COMMANDS,
  COMPLETION_SHELL_CHOICES,
  COMPLEXITY_CHOICES,
  type CompletionChoice,
  type CompletionOption,
  type CompletionSubcommand,
  SHOW_STEP_CHOICES,
  TASK_CONFIG_KEY_CHOICES,
} from './commands.ts'

export type CompletionWriter = {
  write(chunk: string): unknown
}

export type CompletionIo = {
  stdout: CompletionWriter
  stderr: CompletionWriter
}

const defaultIo: CompletionIo = {
  stdout: process.stdout,
  stderr: process.stderr,
}

function zshQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function zshChoice(choice: CompletionChoice): string {
  return zshQuote(`${choice.name}:${choice.description}`)
}

function zshName(value: string): string {
  return zshQuote(value)
}

function zshParam(expression: string): string {
  return ['$', `{${expression}}`].join('')
}

function renderChoiceArray(name: string, choices: readonly CompletionChoice[]): string {
  return [
    `  local -a ${name}`,
    `  ${name}=(`,
    ...choices.map((choice) => `    ${zshChoice(choice)}`),
    '  )',
  ].join('\n')
}

function renderNameArray(name: string, choices: readonly CompletionChoice[]): string {
  return [
    `  local -a ${name}`,
    `  ${name}=(`,
    ...choices.map((choice) => `    ${zshName(choice.name)}`),
    '  )',
  ].join('\n')
}

function commandSpec(name: string) {
  return COMMANDS.find((command) => command.name === name)
}

function optionChoices(
  options: readonly CompletionOption[] | undefined
): readonly CompletionChoice[] {
  return options ?? []
}

function subcommandChoices(
  subcommands: readonly CompletionSubcommand[] | undefined
): readonly CompletionChoice[] {
  return subcommands ?? []
}

function mustCommandSpec(name: string) {
  const spec = commandSpec(name)
  if (!spec) {
    throw new Error(`missing command metadata: ${name}`)
  }
  return spec
}

function mustSubcommandSpec(command: string, subcommand: string) {
  const spec = mustCommandSpec(command).subcommands?.find(
    (candidate) => candidate.name === subcommand
  )
  if (!spec) {
    throw new Error(`missing subcommand metadata: ${command} ${subcommand}`)
  }
  return spec
}

export function completionUsage(): string {
  return 'usage: factory completion zsh'
}

export function renderZshCompletionScript(): string {
  const add = mustCommandSpec('add')
  const run = mustCommandSpec('run')
  const retry = mustCommandSpec('retry')
  const feedback = mustCommandSpec('feedback')
  const correct = mustCommandSpec('correct')
  const backlog = mustCommandSpec('backlog')
  const backlogAdd = mustSubcommandSpec('backlog', 'add')
  const ask = mustCommandSpec('ask')
  const session = mustCommandSpec('session')
  const deck = mustCommandSpec('deck')
  const config = mustCommandSpec('config')
  const configSet = mustSubcommandSpec('config', 'set')
  const configEdit = mustSubcommandSpec('config', 'edit')

  return `${[
    '#compdef factory',
    '',
    '_factory() {',
    renderChoiceArray('_factory_commands', activeCommandChoices()),
    renderChoiceArray('_factory_top_options', [
      { name: '--version', description: 'Print the current CLI version' },
      { name: '--help', description: 'Show help' },
      { name: '-h', description: 'Show help' },
    ]),
    renderChoiceArray('_factory_completion_shells', COMPLETION_SHELL_CHOICES),
    renderChoiceArray('_factory_add_options', optionChoices(add.options)),
    renderChoiceArray('_factory_run_options', optionChoices(run.options)),
    renderChoiceArray('_factory_message_options', optionChoices(retry.options)),
    renderChoiceArray('_factory_feedback_options', optionChoices(feedback.options)),
    renderChoiceArray('_factory_correct_options', optionChoices(correct.options)),
    renderChoiceArray('_factory_backlog_subcommands', subcommandChoices(backlog.subcommands)),
    renderChoiceArray('_factory_backlog_add_options', optionChoices(backlogAdd.options)),
    renderChoiceArray('_factory_ask_options', optionChoices(ask.options)),
    renderChoiceArray('_factory_session_options', optionChoices(session.options)),
    renderChoiceArray('_factory_deck_options', optionChoices(deck.options)),
    renderChoiceArray('_factory_config_subcommands', subcommandChoices(config.subcommands)),
    renderChoiceArray('_factory_config_set_options', optionChoices(configSet.options)),
    renderChoiceArray('_factory_config_keys', TASK_CONFIG_KEY_CHOICES),
    renderChoiceArray('_factory_config_edit_options', optionChoices(configEdit.options)),
    renderChoiceArray('_factory_show_steps', SHOW_STEP_CHOICES),
    renderNameArray('_factory_complexities', COMPLEXITY_CHOICES),
    renderNameArray('_factory_agents', AGENT_CHOICES),
    '',
    '  local state',
    '  local line',
    '  typeset -A opt_args',
    '',
    '  _arguments -C \\',
    "    '(-h --help)'{-h,--help}'[Show help]' \\",
    "    '--version[Print the current CLI version]' \\",
    "    '1:command:->command' \\",
    "    '*::argument:->argument' && return",
    '',
    '  case $state in',
    '    command)',
    `      if [[ ${zshParam('words[CURRENT]-')} == -* ]]; then`,
    "        _describe -t options 'factory option' _factory_top_options",
    '      else',
    "        _describe -t commands 'factory command' _factory_commands",
    '      fi',
    '      ;;',
    '    argument)',
    `      local command="${zshParam('words[1]-')}"`,
    '      case $command in',
    '        add)',
    '          _factory_add',
    '          ;;',
    '        run)',
    '          _factory_describe_current_options _factory_run_options',
    '          ;;',
    '        answer|retry|resume)',
    '          _factory_describe_current_options _factory_message_options',
    '          ;;',
    '        feedback)',
    '          _factory_describe_current_options _factory_feedback_options',
    '          ;;',
    '        correct)',
    '          _factory_describe_current_options _factory_correct_options',
    '          ;;',
    '        backlog)',
    '          _factory_backlog',
    '          ;;',
    '        ask)',
    '          _factory_describe_current_options _factory_ask_options',
    '          ;;',
    '        session)',
    '          _factory_session',
    '          ;;',
    '        config)',
    '          _factory_config',
    '          ;;',
    '        show)',
    "          _describe -t steps 'factory step' _factory_show_steps",
    '          ;;',
    '        deck)',
    '          _factory_describe_current_options _factory_deck_options',
    '          ;;',
    '        completion)',
    "          _describe -t shells 'shell' _factory_completion_shells",
    '          ;;',
    '      esac',
    '      ;;',
    '  esac',
    '}',
    '',
    '_factory_describe_current_options() {',
    '  local array_name="$1"',
    `  if [[ -z ${zshParam('words[CURRENT]-')} || ${zshParam('words[CURRENT]-')} == -* ]]; then`,
    "    _describe -t options 'option' $array_name",
    '  fi',
    '}',
    '',
    '_factory_complete_after_option() {',
    '  local option="$1"',
    '  local array_name="$2"',
    `  local previous="${zshParam('words[$(( CURRENT - 1 ))]-')}"`,
    '  if [[ $previous == $option ]]; then',
    '    compadd -a $array_name',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    '',
    '_factory_complete_equals_option() {',
    '  local prefix="$1"',
    '  local array_name="$2"',
    '  if compset -P "$prefix"; then',
    '    compadd -a $array_name',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    '',
    '_factory_add() {',
    '  _factory_complete_after_option --complexity _factory_complexities && return',
    '  _factory_complete_equals_option --complexity= _factory_complexities && return',
    '  _factory_describe_current_options _factory_add_options',
    '}',
    '',
    '_factory_backlog() {',
    `  local subcommand="${zshParam('words[2]-')}"`,
    '  if (( CURRENT <= 2 )); then',
    "    _describe -t subcommands 'backlog command' _factory_backlog_subcommands",
    '    return',
    '  fi',
    '  case $subcommand in',
    '    add)',
    '      _factory_describe_current_options _factory_backlog_add_options',
    '      ;;',
    '  esac',
    '}',
    '',
    '_factory_session() {',
    '  _factory_complete_after_option --agent _factory_agents && return',
    '  _factory_complete_equals_option --agent= _factory_agents && return',
    '  _factory_describe_current_options _factory_session_options',
    '}',
    '',
    '_factory_config() {',
    `  local subcommand="${zshParam('words[2]-')}"`,
    '  if (( CURRENT <= 2 )); then',
    "    _describe -t subcommands 'config command' _factory_config_subcommands",
    '    return',
    '  fi',
    '  case $subcommand in',
    '    set|get|unset|inherit)',
    '      _factory_config_key',
    '      ;;',
    '    edit)',
    '      _factory_describe_current_options _factory_config_edit_options',
    '      ;;',
    '  esac',
    '}',
    '',
    '_factory_config_key() {',
    `  local previous="${zshParam('words[$(( CURRENT - 1 ))]-')}"`,
    '  if [[ $previous == --task ]]; then',
    '    return',
    '  fi',
    `  if [[ ${zshParam('words[CURRENT]-')} == -* ]]; then`,
    "    _describe -t options 'option' _factory_config_set_options",
    '    return',
    '  fi',
    '  local word',
    `  for word in "${zshParam('words[@]:2')}"; do`,
    '    if [[ $word == on-complete ]]; then',
    '      return',
    '    fi',
    '  done',
    "  _describe -t keys 'config key' _factory_config_keys",
    '}',
    '',
    `if [[ ${zshParam('funcstack[1]')} == _factory ]]; then`,
    '  _factory "$@"',
    'else',
    '  (( $+functions[compdef] )) && compdef _factory factory',
    'fi',
  ].join('\n')}\n`
}

export function runCompletion(args: string[], io: CompletionIo = defaultIo): number {
  const [shell, ...extra] = args
  if (!shell) {
    io.stderr.write(`${completionUsage()}\n`)
    return 1
  }
  if (shell !== 'zsh') {
    io.stderr.write(`unsupported shell "${shell}" (supported: zsh)\n${completionUsage()}\n`)
    return 1
  }
  if (extra.length > 0) {
    io.stderr.write(`${completionUsage()}\n`)
    return 1
  }
  io.stdout.write(renderZshCompletionScript())
  return 0
}
