import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, stat } from 'node:fs/promises'
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
  env: Record<string, string>,
  timeout?: number
): Promise<CliResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    ...(timeout ? { timeout } : {}),
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
  status: string,
  note: string | null = null
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
      note,
    })
  )
  await Bun.write(`${dir}/task.md`, `Fix ${id}\n`)
  return { dir, metaPath }
}

async function runFactory(
  args: string[],
  cwd: string,
  home: string,
  timeout?: number,
  extraEnv: Record<string, string> = {}
): Promise<CliResult> {
  return await runCommand(
    ['bun', cliPath, ...args],
    cwd,
    envWith({ FACTORY_HOME: home, AGENT_WORK_EDITOR: 'true', ...extraEnv }),
    timeout
  )
}

async function delegatedWorktreeFixture(opts: {
  childStatus: string
  chainId: string
  chainStatus: string
  reason?: string
  units: string[]
}): Promise<{
  cwd: string
  home: string
  childRoot: string
  child: { dir: string; metaPath: string }
  childTasksDir: string
}> {
  const cwd = await gitRepo()
  const home = await tempDir('home')
  await Bun.write(`${cwd}/README.md`, 'test\n')
  for (const cmd of [
    ['git', 'add', 'README.md'],
    ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'],
  ]) {
    expect((await runCommand(cmd, cwd, envWith({}))).code).toBe(0)
  }
  const toplevel = await repoToplevel(cwd)
  const repoKey = toplevel.replace(/\//g, '-').replace(/^-+/, '')
  const childRoot = `${home}/worktrees/${repoKey}/child-unit`
  await mkdir(`${home}/worktrees/${repoKey}`, { recursive: true })
  expect(
    (
      await runCommand(
        ['git', 'worktree', 'add', '-qb', 'factory/child-unit', childRoot],
        cwd,
        envWith({})
      )
    ).code
  ).toBe(0)

  const parent = await writeTask(await sessionTasksDir(cwd, home), 'parent', 'delegated')
  const parentMeta = await Bun.file(parent.metaPath).json()
  parentMeta.dispatchChainId = opts.chainId
  await Bun.write(parent.metaPath, JSON.stringify(parentMeta))
  const childTasksDir = await sessionTasksDir(childRoot, home)
  const child = await writeTask(childTasksDir, 'child-unit', opts.childStatus)
  const chainsDir = `${home}/repos/${repoKey}/chains`
  await mkdir(chainsDir, { recursive: true })
  await Bun.write(
    `${chainsDir}/${opts.chainId}.json`,
    JSON.stringify({
      id: opts.chainId,
      parentTaskId: 'parent',
      units: opts.units,
      currentUnit: 'child-unit',
      status: opts.chainStatus,
      reason: opts.reason ?? null,
      updatedAt: new Date().toISOString(),
    })
  )
  return { cwd, home, childRoot, child, childTasksDir }
}

describe('delegated run ownership', () => {
  test('the parent stays up as the foreground supervisor without competing with child hooks', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    const hookLog = `${cwd}/parent-hooks.log`
    await Bun.write(
      `${cwd}/.factory.json`,
      JSON.stringify({
        hooks: {
          attention: [`echo attention >> ${hookLog}`],
          'loop.idle': [`echo idle >> ${hookLog}`],
        },
      })
    )
    const task = await writeTask(await sessionTasksDir(cwd, home), 'parent', 'delegated')
    const meta = await Bun.file(task.metaPath).json()
    meta.dispatchChainId = 'parent-abcd1234'
    await Bun.write(task.metaPath, JSON.stringify(meta))
    const toplevel = await repoToplevel(cwd)
    const repoKey = toplevel.replace(/\//g, '-').replace(/^-+/, '')
    const chainsDir = `${home}/repos/${repoKey}/chains`
    await mkdir(chainsDir, { recursive: true })
    await Bun.write(
      `${chainsDir}/parent-abcd1234.json`,
      JSON.stringify({
        id: 'parent-abcd1234',
        parentTaskId: 'parent',
        units: ['child-unit'],
        currentUnit: 'child-unit',
        status: 'running',
        reason: null,
        updatedAt: new Date().toISOString(),
      })
    )

    const result = await runFactory(['run'], cwd, home, 300)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toContain('parent: staged chain running — child-unit')
    expect(await Bun.file(hookLog).exists()).toBe(false)
  })

  test('factory add in the parent routes answers to the active staged child', async () => {
    const { cwd, home, child, childTasksDir } = await delegatedWorktreeFixture({
      childStatus: 'needs-input',
      chainId: 'parent-route1234',
      chainStatus: 'needs-input',
      reason: 'awaiting answer',
      units: ['child-unit'],
    })
    await Bun.write(
      `${child.dir}/questions.md`,
      'DECISION: ASK\n\n- Should the child preserve the existing fallback?\n'
    )
    await Bun.write(
      `${childTasksDir.replace(/\/tasks$/, '')}/run.lock`,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    )

    const status = await runFactory(['status'], cwd, home)
    expect(status.code).toBe(0)
    expect(status.stdout).toContain('parent → child-unit (1/1)')
    expect(status.stdout).toContain('Should the child preserve the existing fallback?')
    expect(status.stdout).toContain('factory add "…"')

    const result = await runFactory(['add', 'use the recommendation'], cwd, home)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('active workstream: parent → child-unit (1/1)')
    expect(result.stdout).toContain('child-unit: routed as answer')
    expect((await Bun.file(child.metaPath).json()).status).toBe('ready')
  })

  test('parent inspection follows the active staged child', async () => {
    const { cwd, home, child } = await delegatedWorktreeFixture({
      childStatus: 'implementing',
      chainId: 'parent-observe1234',
      chainStatus: 'running',
      units: ['child-unit', 'child-two'],
    })
    await Bun.write(
      `${child.dir}/meter.json`,
      JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
        inputTokens: 1200,
        outputTokens: 300,
        stages: [],
      })
    )
    await Bun.write(
      `${child.dir}/implement.log.activity.jsonl`,
      `${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`
    )

    const status = await runFactory(['status'], cwd, home)
    expect(status.code).toBe(0)
    expect(status.stdout).toContain('parent → child-unit (1/2)')
    expect(status.stdout).toContain('child-unit — implementing')
    expect(status.stdout).toContain('activity ')
    expect(status.stdout).toContain(' ago · runtime')
    expect(status.stdout).toContain('tokens 1.2k in → 300 out')
    expect(status.stdout).not.toContain('⇢ delegated')

    const show = await runFactory(['show'], cwd, home)
    expect(show.code).toBe(0)
    expect(show.stdout).toContain('active workstream: parent → child-unit (1/2)')
    expect(show.stdout).toContain('child-unit  [implementing]')
    expect(show.stdout).toContain('Fix child-unit')
    expect(show.stdout).not.toContain('Fix parent')

    const binDir = await tempDir('bin')
    const fakeClaude = `${binDir}/claude`
    await Bun.write(
      fakeClaude,
      [
        '#!/bin/sh',
        'case "$*" in',
        '  *child-unit*) answer="child context" ;;',
        '  *) answer="parent context" ;;',
        'esac',
        `printf '%s\\n' '{"type":"result","result":"'"$answer"'","usage":{"input_tokens":1,"output_tokens":1}}'`,
        '',
      ].join('\n')
    )
    await chmod(fakeClaude, 0o755)
    const ask = await runFactory(['ask', '--print', 'what is happening?'], cwd, home, undefined, {
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
    })
    expect(ask.code).toBe(0)
    expect(ask.stdout).toContain('active workstream: parent → child-unit (1/2)')
    expect(ask.stdout).toContain('child context')
    expect(ask.stdout).not.toContain('parent context')
  })

  test('parent commands follow nested delegated workstreams without exposing paths', async () => {
    const { cwd, home, childRoot, child } = await delegatedWorktreeFixture({
      childStatus: 'delegated',
      chainId: 'parent-nested1234',
      chainStatus: 'running',
      units: ['child-unit', 'child-two'],
    })
    const childMeta = await Bun.file(child.metaPath).json()
    childMeta.dispatchChainId = 'child-nested1234'
    await Bun.write(child.metaPath, JSON.stringify(childMeta))

    const toplevel = await repoToplevel(cwd)
    const repoKey = toplevel.replace(/\//g, '-').replace(/^-+/, '')
    const grandchildRoot = `${home}/worktrees/${repoKey}/grandchild-unit`
    expect(
      (
        await runCommand(
          ['git', 'worktree', 'add', '-qb', 'factory/grandchild-unit', grandchildRoot],
          cwd,
          envWith({})
        )
      ).code
    ).toBe(0)
    const grandchild = await writeTask(
      await sessionTasksDir(grandchildRoot, home),
      'grandchild-unit',
      'needs-input'
    )
    await Bun.write(
      `${grandchild.dir}/questions.md`,
      'DECISION: ASK\n\n- Which nested behavior should the implementation preserve?\n'
    )
    await Bun.write(
      `${home}/repos/${repoKey}/chains/child-nested1234.json`,
      JSON.stringify({
        id: 'child-nested1234',
        parentTaskId: 'child-unit',
        units: ['nested-one', 'grandchild-unit'],
        currentUnit: 'grandchild-unit',
        status: 'needs-input',
        reason: 'awaiting answer',
        updatedAt: new Date().toISOString(),
      })
    )

    const status = await runFactory(['status'], cwd, home)
    expect(status.code).toBe(0)
    expect(status.stdout).toContain('parent → child-unit (1/2) → grandchild-unit (2/2)')
    expect(status.stdout).toContain('Which nested behavior should the implementation preserve?')
    expect(status.stdout).not.toContain(childRoot)
    expect(status.stdout).not.toContain(grandchildRoot)

    const answer = await runFactory(['add', 'preserve the existing behavior'], cwd, home)
    expect(answer.code).toBe(0)
    expect(answer.stdout).toContain(
      'active workstream: parent → child-unit (1/2) → grandchild-unit (2/2)'
    )
    expect(answer.stdout).toContain('grandchild-unit: routed as answer')
    expect((await Bun.file(grandchild.metaPath).json()).status).toBe('ready')
  })

  test('a broken nested delegation chain fails instead of showing stale parent state', async () => {
    const { cwd, home, child } = await delegatedWorktreeFixture({
      childStatus: 'delegated',
      chainId: 'parent-broken1234',
      chainStatus: 'running',
      units: ['child-unit'],
    })
    const childMeta = await Bun.file(child.metaPath).json()
    childMeta.dispatchChainId = 'missing-child-chain'
    await Bun.write(child.metaPath, JSON.stringify(childMeta))

    const status = await runFactory(['status'], cwd, home)

    expect(status.code).toBe(1)
    expect(status.stdout).toContain(
      'parent → child-unit (1/1): delegated chain missing-child-chain is missing'
    )
    expect(status.stdout).not.toContain('⇢ delegated')
  })

  test('--until-done exits only after the durable chain reaches done', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    await Bun.write(`${cwd}/README.md`, 'test\n')
    for (const cmd of [
      ['git', 'add', 'README.md'],
      ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'],
    ]) {
      expect((await runCommand(cmd, cwd, envWith({}))).code).toBe(0)
    }
    const task = await writeTask(await sessionTasksDir(cwd, home), 'parent', 'delegated')
    const meta = await Bun.file(task.metaPath).json()
    meta.dispatchChainId = 'parent-done1234'
    await Bun.write(task.metaPath, JSON.stringify(meta))
    const toplevel = await repoToplevel(cwd)
    const repoKey = toplevel.replace(/\//g, '-').replace(/^-+/, '')
    const childRoot = `${home}/worktrees/${repoKey}/child-unit`
    await mkdir(`${home}/worktrees/${repoKey}`, { recursive: true })
    expect(
      (
        await runCommand(
          ['git', 'worktree', 'add', '-qb', 'factory/child-unit', childRoot],
          cwd,
          envWith({})
        )
      ).code
    ).toBe(0)
    const childTasksDir = await sessionTasksDir(childRoot, home)
    await writeTask(childTasksDir, 'child-unit', 'done')
    const chainsDir = `${home}/repos/${repoKey}/chains`
    await mkdir(chainsDir, { recursive: true })
    await Bun.write(
      `${chainsDir}/parent-done1234.json`,
      JSON.stringify({
        id: 'parent-done1234',
        parentTaskId: 'parent',
        units: ['child-unit'],
        currentUnit: 'child-unit',
        status: 'done',
        reason: null,
        updatedAt: new Date().toISOString(),
      })
    )

    const result = await runFactory(['run', '--until-done'], cwd, home)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('parent: staged chain complete')
    expect((await Bun.file(task.metaPath).json()).status).toBe('done')
    expect(
      await stat(childRoot).then(
        () => true,
        () => false
      )
    ).toBe(false)
    expect(
      await stat(childTasksDir).then(
        () => true,
        () => false
      )
    ).toBe(false)
  })
})

describe('add parsing parity', () => {
  test('dispatched children persist chain and inherited delivery state', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    const result = await runCommand(
      ['bun', cliPath, 'add', '--raw', '--name', 'child-unit', 'Implement child'],
      cwd,
      envWith({
        FACTORY_HOME: home,
        AGENT_WORK_EDITOR: 'true',
        FACTORY_DISPATCH_CHAIN_ID: 'parent-1234',
        FACTORY_DISPATCH_DELIVERY: JSON.stringify({
          mode: 'skill',
          skill: 'ship',
          source: 'manual',
          confidence: 'high',
          reason: 'Inherited.',
        }),
      })
    )
    expect(result.code).toBe(0)
    const meta = await Bun.file(`${await sessionTasksDir(cwd, home)}/child-unit/meta.json`).json()
    expect(meta.dispatchChainId).toBe('parent-1234')
    expect(meta.delivery).toMatchObject({ mode: 'skill', skill: 'ship', source: 'manual' })
  })

  test('invalid inherited delivery fails at the child boundary', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    const result = await runCommand(
      ['bun', cliPath, 'add', '--raw', '--name', 'invalid-child', 'Implement child'],
      cwd,
      envWith({
        FACTORY_HOME: home,
        AGENT_WORK_EDITOR: 'true',
        FACTORY_DISPATCH_DELIVERY: '{"mode":"unknown"}',
      })
    )
    expect(result.code).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain(
      'FACTORY_DISPATCH_DELIVERY is not a valid task delivery value'
    )
  })

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
  test('retry recovers an implementation committed before the no-changes block', async () => {
    const cwd = await gitRepo()
    const home = await tempDir('home')
    await Bun.write(`${cwd}/base.txt`, 'base\n')
    expect((await runCommand(['git', 'add', 'base.txt'], cwd, envWith({}))).code).toBe(0)
    expect(
      (
        await runCommand(
          [
            'git',
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-qm',
            'base',
          ],
          cwd,
          envWith({})
        )
      ).code
    ).toBe(0)
    const base = (
      await runCommand(['git', 'rev-parse', '--short', 'HEAD'], cwd, envWith({}))
    ).stdout.trim()
    const task = await writeTask(
      await sessionTasksDir(cwd, home),
      'stuck-task',
      'blocked',
      'implementation produced no changes'
    )
    await Bun.write(`${cwd}/implementation.txt`, 'implemented\n')
    expect((await runCommand(['git', 'add', 'implementation.txt'], cwd, envWith({}))).code).toBe(0)
    expect(
      (
        await runCommand(
          [
            'git',
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-qm',
            'implementation',
          ],
          cwd,
          envWith({})
        )
      ).code
    ).toBe(0)

    const result = await runFactory(['retry', 'stuck-task'], cwd, home)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `stuck-task: recovering committed implementation from ${base}..HEAD`
    )
    const meta = await Bun.file(task.metaPath).json()
    expect(meta.status).toBe('ready')
    expect(meta.implementationBaseCommit).toBe(base)
  })

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
