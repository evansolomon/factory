import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises'
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

// The shim shells out to `factory __complete` via ${words[1]}, so the zpty
// harness needs a `factory` executable on PATH that runs the source CLI.
async function factoryWrapperDir(): Promise<string> {
  const dir = await tempDir('completion-bin')
  const wrapper = `${dir}/factory`
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`)
  await chmod(wrapper, 0o755)
  return dir
}

async function runZshCompletion(
  input: string,
  expected: string,
  opts: { cwd?: string; env?: Record<string, string> } = {}
): Promise<CliResult | null> {
  const zsh = Bun.which('zsh')
  if (!zsh) {
    process.stderr.write('skipping zsh completion dispatch smoke: zsh not found\n')
    return null
  }

  const dir = await tempDir('completion-dispatch')
  const binDir = await factoryWrapperDir()
  const scriptPath = `${dir}/_factory`
  const harnessPath = `${dir}/dispatch.zsh`
  await writeFile(scriptPath, renderZshCompletionScript())
  await writeFile(
    harnessPath,
    [
      'zmodload zsh/zpty',
      'zpty -b completion zsh -f -i',
      'zpty -w completion $\'PROMPT="PROMPT> "\\n\'',
      'if [[ -n $COMPLETION_CWD ]]; then',
      '  zpty -w completion $\'cd "$COMPLETION_CWD"\\n\'',
      'fi',
      [
        'zpty -w completion',
        '$\'autoload -Uz compinit\\ncompinit -D\\nsource "$SCRIPT_PATH"',
        '\\nbindkey "^I" complete-word\\n\'',
      ].join(' '),
      'zpty -w -n completion "$COMPLETION_INPUT"',
      'local output chunk deadline=$((SECONDS + 15))',
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
    COMPLETION_CWD: opts.cwd ?? '',
    PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
    ...(opts.env ?? {}),
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

  test('top-level completion includes active commands and hides internal ones', () => {
    const choices = activeCommandChoices().map((choice) => choice.name)

    expect(choices).toEqual([
      'add',
      'run',
      'retry',
      'feedback',
      'correct',
      'close',
      'backlog',
      'dispatch',
      'config',
      'status',
      'ask',
      'session',
      'codex',
      'claude',
      'show',
      'deck',
      'delivery',
      'report',
      'harvest',
      'gc',
      'skills',
      'evals',
      'lessons',
      'version',
      'upgrade',
      'completion',
      'help',
    ])
    expect(choices).not.toContain('answer')
    expect(choices).not.toContain('resume')
    expect(choices).not.toContain('__complete')
  })

  test('shim delegates all candidates to the hidden helper', () => {
    const script = renderZshCompletionScript()

    // Invokes the completed binary itself with the 0-based cursor index.
    expect(script).toContain(`"${zshParameter('words[1]')}" __complete $(( CURRENT - 2 ))`)
    expect(script).toContain('2>/dev/null')
    // Tab-separated name/description lines feed _describe, with ':' escaped in names.
    expect(script).toContain(`name=${zshParameter('name//:/\\\\:')}`)
    expect(script).toContain('_describe -t factory-candidates')
    // The script itself enumerates no commands — that would reintroduce drift.
    expect(script).not.toContain('backlog')
    expect(script).not.toContain('lessons')
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
    const home = await tempDir('completion-zpty-home')
    const version = await runZshCompletion('factory ve\t', 'factory version', {
      env: { FACTORY_HOME: home },
    })
    if (!version) {
      return
    }

    expect(version.stderr).toBe('')
    expect(version.code).toBe(0)
    expect(version.stdout).toContain('factory version')

    const configEdit = await runZshCompletion('factory config \t', 'factory config edit', {
      env: { FACTORY_HOME: home },
    })
    expect(configEdit?.stderr).toBe('')
    expect(configEdit?.code).toBe(0)
    expect(configEdit?.stdout).toContain('factory config edit')

    const backlog = await runZshCompletion('factory backlog \t\t', 'Remove a backlog entry', {
      env: { FACTORY_HOME: home },
    })
    expect(backlog?.stderr).toBe('')
    expect(backlog?.code).toBe(0)
    expect(backlog?.stdout).toContain('add')
    expect(backlog?.stdout).toContain('rm')
  })

  test('real zsh dispatch completes lessons choices when available', async () => {
    const home = await tempDir('completion-zpty-home')
    const lessons = await runZshCompletion('factory lessons \t\t', 'Edit a learned lesson', {
      env: { FACTORY_HOME: home },
    })
    if (!lessons) {
      return
    }

    expect(lessons.stderr).toBe('')
    expect(lessons.code).toBe(0)
    expect(lessons.stdout).toContain('edit')
  })

  test('real zsh dispatch completes a task step from activity files when available', async () => {
    const zsh = Bun.which('zsh')
    if (!zsh) {
      process.stderr.write('skipping zsh dynamic completion smoke: zsh not found\n')
      return
    }
    // A real repo with a fabricated task whose only activity file is triage:
    // the motivating case — `factory show tri<TAB>` → triage.
    const repo = await realpath(await tempDir('completion-repo'))
    const home = await realpath(await tempDir('completion-repo-home'))
    const init = await runCommand(['git', 'init', '-q', repo])
    expect(init.code).toBe(0)

    const worktreeKey = repo.replace(/\//g, '-').replace(/^-+/, '')
    const taskDir = `${home}/sessions/${worktreeKey}/tasks/fix-login`
    await mkdir(taskDir, { recursive: true })
    await writeFile(
      `${taskDir}/meta.json`,
      JSON.stringify({
        id: 'fix-login',
        slug: 'fix-login',
        status: 'done',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    )
    await writeFile(`${taskDir}/triage.activity.jsonl`, '{"type":"turn.completed"}\n')

    const result = await runZshCompletion('factory show tri\t', 'factory show triage', {
      cwd: repo,
      env: { FACTORY_HOME: home },
    })
    expect(result?.stderr).toBe('')
    expect(result?.code).toBe(0)
    expect(result?.stdout).toContain('factory show triage')
  })
})
