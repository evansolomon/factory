import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { activeCommandChoices } from '../src/commands.ts'
import { renderZshCompletionScript, runCompletion } from '../src/completion.ts'

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const zshParameter = (expression: string) => ['$', `{${expression}}`].join('')

type CliResult = {
  stdout: string
  stderr: string
  code: number
}

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(`${tmpdir()}/factory-${prefix}-`)
}

function envWith(values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  for (const [key, value] of Object.entries(values)) {
    env[key] = value
  }
  return env
}

function captureCompletion(args: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  const code = runCompletion(args, {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
  })
  return { code, stdout, stderr }
}

async function runFactory(
  args: string[],
  cwd: string,
  env: Record<string, string>
): Promise<CliResult> {
  const proc = Bun.spawn(['bun', cliPath, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, code }
}

async function runCommand(cmd: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const proc = Bun.spawn(cmd, {
    env: envWith(env),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

async function runZshCompletion(input: string, expected: string): Promise<CliResult | null> {
  const zsh = Bun.which('zsh')
  if (!zsh) {
    process.stderr.write('skipping zsh completion dispatch smoke: zsh not found\n')
    return null
  }

  const dir = await tempDir('completion-dispatch')
  const scriptPath = `${dir}/_factory`
  const harnessPath = `${dir}/dispatch.zsh`
  await writeFile(scriptPath, renderZshCompletionScript())
  await writeFile(
    harnessPath,
    [
      'zmodload zsh/zpty',
      'zpty -b completion zsh -f -i',
      'zpty -w completion $\'PROMPT="PROMPT> "\\n\'',
      [
        'zpty -w completion',
        '$\'autoload -Uz compinit\\ncompinit -D\\nsource "$SCRIPT_PATH"',
        '\\nbindkey "^I" complete-word\\n\'',
      ].join(' '),
      'zpty -w -n completion "$COMPLETION_INPUT"',
      'local output chunk deadline=$((SECONDS + 3))',
      'while (( SECONDS < deadline )); do',
      '  if zpty -r -t completion chunk; then',
      '    output+=$chunk',
      '    [[ $output == *$COMPLETION_EXPECT* ]] && break',
      '  else',
      '    sleep 0.1',
      '  fi',
      'done',
      'print -r -- "$output"',
      'zpty -d completion',
      '',
    ].join('\n')
  )

  return await runCommand([zsh, '-f', harnessPath], {
    SCRIPT_PATH: scriptPath,
    COMPLETION_INPUT: input,
    COMPLETION_EXPECT: expected,
  })
}

describe('zsh completion script', () => {
  test('renders a dual-mode zsh completion function', () => {
    const script = renderZshCompletionScript()

    expect(script.startsWith('#compdef factory\n')).toBe(true)
    expect(script).toContain('_factory() {')
    expect(script).toContain('(( $+functions[compdef] )) && compdef _factory factory')
    expect(script).toContain(
      `if [[ ${zshParameter('funcstack[1]')} == _factory ]]; then\n  _factory "$@"\nelse`
    )
  })

  test('top-level completion includes active commands and hides deprecated aliases', () => {
    const choices = activeCommandChoices().map((choice) => choice.name)

    expect(choices).toEqual([
      'add',
      'run',
      'retry',
      'feedback',
      'correct',
      'backlog',
      'config',
      'status',
      'ask',
      'session',
      'codex',
      'claude',
      'show',
      'report',
      'lessons',
      'version',
      'upgrade',
      'completion',
      'help',
    ])
    expect(choices).not.toContain('answer')
    expect(choices).not.toContain('resume')
  })

  test('generated script includes top-level options and fixed grammar choices', () => {
    const script = renderZshCompletionScript()

    for (const token of [
      '--version:Print the current CLI version',
      '--help:Show help',
      '-h:Show help',
      'zsh:Print zsh completion script',
      'add:Add an intent to the backlog',
      'rm:Remove a backlog entry',
      '--raw:Skip sharpening for the backlog entry',
      '--verify:Set a verify command for the backlog entry',
      '--edit:Compose the intent in $EDITOR',
      '--complexity:Declare the new task complexity',
      'trivial',
      'complex',
      '--agent:Choose the interactive agent',
      '--agent=:Choose the interactive agent',
      'codex',
      'claude',
      '--message:Provide the message inline',
      '--message=:Provide the message inline',
      '-m:Provide the message inline',
      'set:Set a task-local config value',
      'get:Show a task-local config value',
      'unset:Disable a task-local config value',
      'inherit:Clear the task-local override',
      'edit:Open a config file in $EDITOR',
      'on-complete:Task-local delivery instructions',
      'list:List learned lessons',
      'show:Show a learned lesson',
      'rm:Remove a learned lesson',
      'edit:Edit a learned lesson',
      '--all:Include deleted learned lessons',
      '--scope:Filter by scope',
      '--stage:Filter by stage',
      '--message:Provide the lesson text inline',
      '--edit:Compose the lesson text in $EDITOR',
      'global',
      'repo',
      'deploy-safety',
    ]) {
      expect(script).toContain(token)
    }
  })

  test('config set completes on-complete as the fixed key only', () => {
    const script = renderZshCompletionScript()

    expect(script).toContain("_describe -t keys 'config key' _factory_config_keys")
    expect(script.match(/on-complete:Task-local delivery instructions/g) ?? []).toHaveLength(1)
  })
})

describe('completion command', () => {
  test('prints zsh completion to stdout', () => {
    const result = captureCompletion(['zsh'])

    expect(result.code).toBe(0)
    expect(result.stdout.startsWith('#compdef factory\n')).toBe(true)
    expect(result.stderr).toBe('')
  })

  test('usage and unsupported shell errors go to stderr', () => {
    expect(captureCompletion([])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'usage: factory completion zsh\n',
    })
    expect(captureCompletion(['bash'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'unsupported shell "bash" (supported: zsh)\nusage: factory completion zsh\n',
    })
  })

  test('factory completion zsh works outside a git repo without touching FACTORY_HOME', async () => {
    const cwd = await tempDir('completion-cwd')
    const home = await tempDir('completion-home')
    const result = await runFactory(['completion', 'zsh'], cwd, envWith({ FACTORY_HOME: home }))

    expect(result.code).toBe(0)
    expect(result.stdout.startsWith('#compdef factory\n')).toBe(true)
    expect(result.stderr).toBe('')
    expect(await readdir(home)).toEqual([])
  })
})

describe('zsh completion smoke', () => {
  test('generated script parses under zsh when zsh is available', async () => {
    const zsh = Bun.which('zsh')
    if (!zsh) {
      process.stderr.write('skipping zsh completion smoke: zsh not found\n')
      return
    }
    const dir = await tempDir('completion-zsh')
    const scriptPath = `${dir}/_factory`
    await writeFile(scriptPath, renderZshCompletionScript())

    const result = await runCommand([zsh, '-n', scriptPath])

    expect(result).toEqual({ stdout: '', stderr: '', code: 0 })
  })

  test('source mode registers the factory completion when zsh is available', async () => {
    const zsh = Bun.which('zsh')
    if (!zsh) {
      process.stderr.write('skipping zsh source completion smoke: zsh not found\n')
      return
    }
    const dir = await tempDir('completion-source')
    const scriptPath = `${dir}/_factory`
    await writeFile(scriptPath, renderZshCompletionScript())

    const result = await runCommand(
      [
        zsh,
        '-fc',
        `autoload -Uz compinit; compinit -D; source "$SCRIPT_PATH"; print -- ${zshParameter('+functions[_factory]')}; print -- ${zshParameter('_comps[factory]-')}`,
      ],
      { SCRIPT_PATH: scriptPath }
    )

    expect(result).toEqual({ stdout: '1\n_factory\n', stderr: '', code: 0 })
  })

  test('fpath mode autoloads the _factory file when zsh is available', async () => {
    const zsh = Bun.which('zsh')
    if (!zsh) {
      process.stderr.write('skipping zsh fpath completion smoke: zsh not found\n')
      return
    }
    const dir = await tempDir('completion-fpath')
    const completionDir = `${dir}/completions`
    await mkdir(completionDir)
    await writeFile(`${completionDir}/_factory`, renderZshCompletionScript())

    const result = await runCommand(
      [
        zsh,
        '-fc',
        `fpath=("$COMPLETION_DIR" $fpath); autoload -Uz compinit; compinit -D; autoload -Uz +X _factory; print -- ${zshParameter('+functions[_factory]')}`,
      ],
      { COMPLETION_DIR: completionDir }
    )

    expect(result).toEqual({ stdout: '1\n', stderr: '', code: 0 })
  })

  test('real zsh dispatch completes top-level and command-specific choices when available', async () => {
    const version = await runZshCompletion('factory ve\t', 'factory version')
    if (!version) {
      return
    }

    expect(version.stderr).toBe('')
    expect(version.code).toBe(0)
    expect(version.stdout).toContain('factory version')

    const configSet = await runZshCompletion(
      'factory config set \t',
      'factory config set on-complete'
    )
    expect(configSet?.stderr).toBe('')
    expect(configSet?.code).toBe(0)
    expect(configSet?.stdout).toContain('factory config set on-complete')

    const backlog = await runZshCompletion('factory backlog \t\t', 'Remove a backlog entry')
    expect(backlog?.stderr).toBe('')
    expect(backlog?.code).toBe(0)
    expect(backlog?.stdout).toContain('add')
    expect(backlog?.stdout).toContain('rm')
  })

  test('real zsh dispatch completes lessons choices when available', async () => {
    const lessons = await runZshCompletion('factory lessons \t\t', 'Edit a learned lesson')
    if (!lessons) {
      return
    }

    expect(lessons.stderr).toBe('')
    expect(lessons.code).toBe(0)
    expect(lessons.stdout).toContain('edit')
  })
})
