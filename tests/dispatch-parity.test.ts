import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Parity pins for the registry-driven dispatch rewrite: one focused case per
// rewritten parsing style, asserting today's exact output and exit codes for
// the flag-token quirks each command's historical parser had.

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

type CliResult = {
  stdout: string
  stderr: string
  code: number
}

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(`${tmpdir()}/factory-parity-${prefix}-`)
}

function envWith(values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return { ...env, ...values }
}

async function runCommand(
  cmd: string[],
  cwd: string,
  env: Record<string, string>
): Promise<CliResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

async function gitRepo(): Promise<string> {
  const root = await tempDir('repo')
  const result = await runCommand(['git', 'init', '-q'], root, envWith({}))
  expect(result.code).toBe(0)
  return root
}

async function repoToplevel(root: string): Promise<string> {
  const result = await runCommand(['git', 'rev-parse', '--show-toplevel'], root, envWith({}))
  expect(result.code).toBe(0)
  return result.stdout.trim()
}

async function sessionTasksDir(root: string, home: string): Promise<string> {
  const toplevel = await repoToplevel(root)
  const worktreeKey = toplevel.replace(/\//g, '-').replace(/^-+/, '')
  return `${home}/sessions/${worktreeKey}/tasks`
}

async function writeTask(
  tasksDir: string,
  id: string,
  status: string
): Promise<{ dir: string; metaPath: string }> {
  const dir = `${tasksDir}/${id}`
  await mkdir(dir, { recursive: true })
  const metaPath = `${dir}/meta.json`
  await Bun.write(
    metaPath,
    JSON.stringify({
      id,
      slug: id,
      status,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  )
  await Bun.write(`${dir}/task.md`, `Fix ${id}\n`)
  return { dir, metaPath }
}

async function runFactory(args: string[], cwd: string, home: string): Promise<CliResult> {
  return await runCommand(
    ['bun', cliPath, ...args],
    cwd,
    envWith({ FACTORY_HOME: home, AGENT_WORK_EDITOR: 'true' })
  )
}

describe('add parsing parity', () => {
  test('complexity flags after --verify are rejected', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(
      ['add', 'fix', 'it', '--verify', 'bun', 'test', '--trivial'],
      cwd,
      home
    )
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('complexity flags must appear before --verify')
  })

  test('unknown flag-ish tokens land in the intent', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    // --name skips the AI namer, keeping this hermetic.
    const result = await runFactory(['add', '--name', 'my-task', 'foo', '--json', 'bar'], cwd, home)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('queued my-task')
    const tasksDir = await sessionTasksDir(cwd, home)
    expect((await Bun.file(`${tasksDir}/my-task/task.md`).text()).trim()).toBe('foo --json bar')
  })
})

describe('add single-lane invariant', () => {
  test('a second fresh task is an error', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const first = await runFactory(['add', '--name', 'task-a', 'first', 'thing'], cwd, home)
    expect(first.code).toBe(0)
    const second = await runFactory(['add', '--name', 'task-b', 'second', 'thing'], cwd, home)
    expect(second.code).toBe(1)
    expect(second.stdout).toContain('already has a fresh queued task: task-a')
  })

  test('a new task on a dirty worktree is an error without --allow-dirty', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    await Bun.write(`${cwd}/leftover.txt`, 'uncommitted\n')

    const denied = await runFactory(['add', '--name', 'task-a', 'new', 'thing'], cwd, home)
    expect(denied.code).toBe(1)
    expect(denied.stdout).toContain('uncommitted changes')

    const allowed = await runFactory(
      ['add', '--allow-dirty', '--name', 'task-a', 'new', 'thing'],
      cwd,
      home
    )
    expect(allowed.code).toBe(0)
    expect(allowed.stdout).toContain('queued task-a')
  })

  test('--allow-dirty is rejected when add routes into existing work', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    const tasksDir = await sessionTasksDir(cwd, home)
    await writeTask(tasksDir, 'parked', 'needs-input')

    const result = await runFactory(['add', '--allow-dirty', 'an', 'answer'], cwd, home)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('--allow-dirty only applies when add queues a new task')
  })
})

describe('backlog add parsing parity', () => {
  test('--raw counts and is stripped even inside the --verify tail', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(
      ['backlog', 'add', 'fix', 'the', 'header', '--verify', 'bun', 'test', '--raw'],
      cwd,
      home
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('backlog +fix-the-header (verify: bun test)')
  })

  test('--edit inside the --verify tail opens the editor and is stripped', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runCommand(
      ['bun', cliPath, 'backlog', 'add', 'seed', '--verify', 'bun', 'test', '--edit'],
      cwd,
      // An editor that rewrites the buffer, proving it actually ran.
      envWith({ FACTORY_HOME: home, AGENT_WORK_EDITOR: 'echo edited intent >' })
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('backlog +edited-intent (verify: bun test)')
  })

  test('unknown flag-ish tokens stay in the intent', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(['backlog', 'add', '--raw', 'fix', '--json', 'mode'], cwd, home)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('backlog +fix-json-mode')
  })
})

describe('message-command parsing parity', () => {
  test('repeated -m: last value wins as the retry note', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    const tasksDir = await sessionTasksDir(cwd, home)
    const task = await writeTask(tasksDir, 'stuck-task', 'blocked')

    const result = await runFactory(['retry', 'stuck-task', '-m', 'a', '-m', 'b'], cwd, home)
    expect(result.code).toBe(0)
    const meta = await Bun.file(task.metaPath).json()
    expect(meta.status).toBe('ready')
    expect(meta.resumeNote).toBe('b')
  })

  test('unknown option errors with the exact message and usage', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(['retry', 'stuck-task', '--wat'], cwd, home)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(
      'unknown option --wat\nusage: factory retry [task-id] [-m <note> | --edit]'
    )
  })
})

describe('session parsing parity', () => {
  test('-x is a positional task query, not an option error', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    // Parse succeeds, so the non-TTY guard is what rejects it.
    const result = await runFactory(['session', '-x'], cwd, home)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('factory session needs an interactive terminal')
  })

  test('--wat is an option error before the TTY guard', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(['session', '--wat'], cwd, home)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('unknown option --wat')
    expect(result.stdout).not.toContain('interactive terminal')
  })
})

describe('deck parsing parity', () => {
  test('lone - and unknown flags are option errors', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const loneDash = await runFactory(['deck', '-'], cwd, home)
    expect(loneDash.code).toBe(1)
    expect(loneDash.stdout).toContain('unknown option -\nusage: factory deck [task-id] [--url]')

    const unknown = await runFactory(['deck', '--wat'], cwd, home)
    expect(unknown.code).toBe(1)
    expect(unknown.stdout).toContain('unknown option --wat\nusage: factory deck [task-id] [--url]')
  })
})

describe('tolerant-command parsing parity', () => {
  test('report ignores a lone - and unknown flags', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(['report', '-'], cwd, home)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('no tasks in this worktree')
  })

  test('run tolerates unknown flags', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(['run', '--once', '--bogus'], cwd, home)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('running one task')
  })
})

describe('delivery parsing parity', () => {
  test('flag-looking words are policy text, never dropped', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    const tasksDir = await sessionTasksDir(cwd, home)
    const task = await writeTask(tasksDir, 'live-task', 'ready')

    const result = await runFactory(['delivery', 'keep', '--it', 'simple'], cwd, home)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('delivery set to policy:keep --it simple')
    const meta = await Bun.file(task.metaPath).json()
    expect(meta.delivery).toMatchObject({ mode: 'policy', policy: 'keep --it simple' })
  })

  test('repeated --task is a usage error', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(['delivery', '--task', 'a', '--task', 'b', 'none'], cwd, home)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('usage: factory delivery [--task <id>]')
  })
})

describe('config parsing parity', () => {
  test('edit accepts the legacy positional directory', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    const layer = await tempDir('layer')

    const result = await runFactory(['config', 'edit', layer], cwd, home)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`editing ${layer}/.factory.json`)
    expect(await Bun.file(`${layer}/.factory.json`).text()).toBe('{}\n')
  })

  test('edit without flags targets the global config', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(['config', 'edit', '--global'], cwd, home)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`editing ${home}/config.json`)
  })

  test('config set is still rejected with the delivery pointer', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(['config', 'set', 'on-complete', 'x'], cwd, home)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(
      'task delivery moved out of config; use: factory delivery [--task <id>] ...'
    )
  })
})

describe('dispatch parsing parity', () => {
  test('--limit validates its value', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(['dispatch', '--limit', 'x'], cwd, home)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('--limit needs a positive number')
  })

  test('first --limit wins on repeats', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    for (const intent of ['fix the header', 'fix the footer', 'fix the sidebar']) {
      const added = await runFactory(['backlog', 'add', '--raw', intent], cwd, home)
      expect(added.code).toBe(0)
    }

    const result = await runFactory(
      ['dispatch', '--dry-run', '--limit', '2', '--limit', '5'],
      cwd,
      home
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('would dispatch 2 items')
  })
})

describe('subcommand usage parity', () => {
  test('lessons edit rejects unknown flags with the usage string', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const result = await runFactory(['lessons', 'edit', 'someid', '--wat'], cwd, home)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('usage: factory lessons edit <id>')
  })

  test('evals, skills, and backlog rm reject bad subcommand shapes', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')

    const evals = await runFactory(['evals', 'wat'], cwd, home)
    expect(evals.code).toBe(1)
    expect(evals.stdout).toContain('usage: factory evals [list | run [case-substring] [--keep]]')

    const skills = await runFactory(['skills', 'wat'], cwd, home)
    expect(skills.code).toBe(1)
    expect(skills.stdout).toContain(
      'usage: factory skills [list | edit <name> [--repo|--global|--committed]]'
    )

    const backlogRm = await runFactory(['backlog', 'rm'], cwd, home)
    expect(backlogRm.code).toBe(1)
    expect(backlogRm.stdout).toContain('usage: factory backlog rm <id>')
  })
})

describe('ask parsing parity', () => {
  test('--print is recognized only at position 0', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    const tasksDir = await sessionTasksDir(cwd, home)
    await writeTask(tasksDir, 'done-task', 'done')

    // Position 0 with no question: the --print usage error, no session attempted.
    const print = await runFactory(['ask', '--print'], cwd, home)
    expect(print.code).toBe(1)
    expect(print.stdout).toContain('usage: factory ask --print [task-id] <question...>')

    // Anywhere else it is question text — session mode, rejected by the TTY guard.
    const question = await runFactory(
      ['ask', 'done-task', 'what', 'does', '--print', 'do'],
      cwd,
      home
    )
    expect(question.code).toBe(1)
    expect(question.stdout).toContain('factory ask is interactive and needs a terminal')
  })
})
