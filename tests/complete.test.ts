import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { ValueSource } from '../src/commands.ts'
import {
  type Candidate,
  completeCandidates,
  contextResolver,
  type SourceResolver,
} from '../src/complete.ts'
import type { Config, RepoContext, RoleAgents, WorkContext } from '../src/config.ts'
import { addTask, writeArtifact } from '../src/task.ts'

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(`${tmpdir()}/factory-${prefix}-`)
}

// A resolver that answers every dynamic source with a labeled marker, so the
// registry-walk logic is testable without any filesystem state.
const fakeResolver: SourceResolver = async (source) => {
  switch (source.kind) {
    case 'static':
      return source.choices.map(({ name, description }) => ({ name, description }))
    case 'none':
      return []
    case 'skill-name':
      return [
        {
          name: source.insert === 'directive' ? '$ship' : 'ship',
          description: 'Ship the change',
        },
      ]
    case 'show-step':
      return [{ name: `step:${source.task}`, description: 'step' }]
    default:
      return [{ name: `<${source.kind}>`, description: source.kind }]
  }
}

async function names(words: string[], cword: number): Promise<string[]> {
  return (await completeCandidates(words, cword, fakeResolver)).map((c) => c.name)
}

describe('completeCandidates registry walk', () => {
  test('command position lists active commands, hides internal ones', async () => {
    const commands = await names([''], 0)
    for (const name of ['dispatch', 'harvest', 'close', 'gc', 'delivery', 'skills', 'evals']) {
      expect(commands).toContain(name)
    }
    expect(commands).not.toContain('answer')
    expect(commands).not.toContain('resume')
    expect(commands).not.toContain('__complete')
  })

  test('dash partial at command position offers top-level options', async () => {
    expect(await names(['--'], 0)).toEqual(['--version', '--help', '-h'])
  })

  test('previously missing flags complete on their commands', async () => {
    expect(await names(['add', '--'], 1)).toEqual(
      expect.arrayContaining(['--force-new', '--name', '--verify', '--edit'])
    )
    expect(await names(['run', '--'], 1)).toContain('--until-done')
    expect(await names(['run', '--'], 1)).toContain('--no-prompt')
    expect(await names(['dispatch', '--'], 1)).toEqual(
      expect.arrayContaining(['--dry-run', '--limit'])
    )
    expect(await names(['harvest', '--'], 1)).toContain('--all')
    expect(await names(['gc', '--'], 1)).toContain('--dry-run')
    expect(await names(['report', '--'], 1)).toContain('--all')
    expect(await names(['config', 'edit', '--'], 2)).toContain('--repo')
    expect(await names(['evals', 'run', '--'], 2)).toContain('--keep')
    expect(await names(['retry', '-'], 1)).toEqual(['--message', '-m', '--edit'])
  })

  test('config offers only edit — set/get/unset/inherit are gone', async () => {
    expect(await names(['config', ''], 1)).toEqual(['edit'])
  })

  test('subcommands complete for skills and evals', async () => {
    expect(await names(['skills', ''], 1)).toEqual(['list', 'edit'])
    expect(await names(['evals', ''], 1)).toEqual(['list', 'run'])
    expect(await names(['evals', 'run', ''], 2)).toContain('<eval-case>')
    expect(await names(['skills', 'edit', ''], 2)).toContain('ship')
  })

  test('flag values resolve from their declared sources', async () => {
    expect(await names(['delivery', '--task', ''], 2)).toEqual(['<task-id>'])
    expect(await names(['session', '--agent', ''], 2)).toEqual(['codex', 'claude'])
    expect(await names(['lessons', 'list', '--scope', ''], 3)).toEqual(['global', 'repo'])
    expect(await names(['lessons', 'curate', '--eval-case', ''], 3)).toEqual(['<eval-case>'])
  })

  test('equals form completes full --flag=value strings', async () => {
    expect(await names(['session', '--agent=c'], 1)).toEqual(['--agent=codex', '--agent=claude'])
    expect(await names(['lessons', 'list', '--scope=g'], 2)).toEqual([
      '--scope=global',
      '--scope=repo',
    ])
  })

  test('task-id positionals resolve for the task commands', async () => {
    for (const command of ['retry', 'feedback', 'correct', 'close', 'session', 'deck', 'report']) {
      expect(await names([command, ''], 1)).toContain('<task-id>')
    }
    expect(await names(['harvest', ''], 1)).toContain('<task-id>')
  })

  test('show offers task ids plus latest-task steps, then the chosen task steps', async () => {
    expect(await names(['show', ''], 1)).toEqual(['<task-id>', 'step:latest'])
    expect(await names(['show', 'fix-login', ''], 2)).toEqual(['step:arg1'])
  })

  test('lesson and backlog ids complete where those commands take them', async () => {
    expect(await names(['lessons', 'show', ''], 2)).toEqual(['<lesson-id>'])
    expect(await names(['lessons', 'rm', ''], 2)).toEqual(['<lesson-id>'])
    expect(await names(['lessons', 'edit', ''], 2)).toEqual(expect.arrayContaining(['<lesson-id>']))
    expect(await names(['backlog', 'rm', ''], 2)).toEqual(['<backlog-id>'])
  })

  test('delivery positional offers none and the $skill directive form', async () => {
    const candidates = await names(['delivery', ''], 1)
    expect(candidates).toContain('none')
    expect(candidates).toContain('$ship')
    expect(candidates).toContain('--task')
  })

  test('nothing completes after --verify', async () => {
    expect(await names(['add', 'fix', '--verify', 'bun', ''], 4)).toEqual([])
    expect(await names(['backlog', 'add', '--verify', ''], 3)).toEqual([])
  })

  test('hidden commands still complete their own flags', async () => {
    expect(await names(['resume', '-'], 1)).toEqual(['--message', '-m', '--edit'])
  })

  test('unknown command yields nothing', async () => {
    expect(await names(['wat', ''], 1)).toEqual([])
  })
})

const config: Config = {
  retries: 10,
  triage: true,
  security: true,
  ux: true,
  plansDir: null,
  captureEvals: false,
  postmortem: false,
  remediate: true,
  workforce: true,
  rescue: true,
  autoAcceptAfterMinutes: null,
  implementerAccess: 'write',
  autoShip: null,
  dispatch: null,
  specialists: {},
  hooks: {},
  agents: {
    planners: ['codex', 'claude'],
    implementer: 'codex',
    reviewer: 'claude',
    delivery: 'claude',
    workforce: 'claude',
    rescue: 'claude',
    researchers: {},
    reviewers: {},
    implementers: {},
    namer: { cli: 'codex', model: 'gpt-5.4-mini', reasoningEffort: 'low' },
  },
  ask: { agent: 'claude' },
}

const agents: RoleAgents = {
  planners: [{ cli: 'codex' }, { cli: 'claude' }],
  implementer: { cli: 'codex' },
  reviewer: { cli: 'claude' },
  delivery: { cli: 'claude' },
  namer: { cli: 'codex', model: 'gpt-5.4-mini', reasoningEffort: 'low' },
}

async function workContext(): Promise<WorkContext> {
  const root = await tempDir('complete-work')
  const stateDir = `${root}/state`
  return {
    root,
    config,
    stateDir,
    tasksDir: `${stateDir}/tasks`,
    plansDir: null,
    agents,
    askAgent: { cli: 'claude' },
    repoStateDir: stateDir,
    metricsPath: `${stateDir}/metrics.db`,
    envPlaybookPath: `${stateDir}/env/test-host.md`,
  }
}

function fixtureResolver(ctx: WorkContext, repo?: RepoContext): SourceResolver {
  return contextResolver(
    async () => ctx,
    async () => {
      if (!repo) {
        throw new Error('no repo context in this fixture')
      }
      return repo
    }
  )
}

async function resolveNames(
  resolver: SourceResolver,
  source: ValueSource,
  words: string[]
): Promise<Candidate[]> {
  return await resolver(source, { words })
}

describe('contextResolver with real task fixtures', () => {
  test('show steps come from the task dir activity files, task ids carry status', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Fix the login flow', null)
    await writeArtifact(task, 'triage.activity.jsonl', '{"type":"turn.completed"}')
    await writeArtifact(task, 'implement.activity.jsonl', '{"type":"turn.completed"}')
    const resolver = fixtureResolver(ctx)

    const tasks = await resolveNames(resolver, { kind: 'task-id' }, ['show', ''])
    expect(tasks).toEqual([{ name: task.id, description: 'ready' }])

    const steps = await resolveNames(resolver, { kind: 'show-step', task: 'latest' }, ['show', ''])
    expect(steps.map((s) => s.name)).toEqual(['implement', 'triage'])
    expect(steps.find((s) => s.name === 'triage')?.description).toBe('agent activity step')
    expect(steps.find((s) => s.name === 'implement')?.description).toBe('Implementation activity')

    const argSteps = await resolveNames(resolver, { kind: 'show-step', task: 'arg1' }, [
      'show',
      task.id,
      '',
    ])
    expect(argSteps.map((s) => s.name)).toEqual(['implement', 'triage'])
  })

  test('a task with no activity files yields no step candidates — no static fallback', async () => {
    const ctx = await workContext()
    await addTask(ctx, 'Fix the login flow', null)
    const resolver = fixtureResolver(ctx)

    const steps = await resolveNames(resolver, { kind: 'show-step', task: 'latest' }, ['show', ''])
    expect(steps).toEqual([])
  })

  test('one corrupt meta.json does not disable task-id completion for the rest', async () => {
    const ctx = await workContext()
    const good = await addTask(ctx, 'Fix the login flow', null)
    await mkdir(`${ctx.tasksDir}/broken-task`, { recursive: true })
    await writeFile(`${ctx.tasksDir}/broken-task/meta.json`, '{not json')
    const resolver = fixtureResolver(ctx)

    const tasks = await resolveNames(resolver, { kind: 'task-id' }, ['show', ''])
    expect(tasks.map((t) => t.name)).toEqual([good.id])
  })

  test('every source failure yields no candidates, never an error', async () => {
    const resolver = contextResolver(
      async () => {
        throw new Error('no factory state here')
      },
      async () => {
        throw new Error('no repo here')
      }
    )
    for (const source of [
      { kind: 'task-id' },
      { kind: 'show-step', task: 'latest' },
      { kind: 'lesson-id' },
      { kind: 'backlog-id' },
      { kind: 'eval-case' },
      { kind: 'skill-name', insert: 'bare' },
    ] satisfies ValueSource[]) {
      expect(await resolveNames(resolver, source, ['show', ''])).toEqual([])
    }
  })

  test('backlog ids resolve from the repo context', async () => {
    const ctx = await workContext()
    const backlogDir = `${ctx.stateDir}/backlog`
    await mkdir(backlogDir, { recursive: true })
    await writeFile(
      `${backlogDir}/fix-header.json`,
      JSON.stringify({
        id: 'fix-header',
        intent: 'Fix the header',
        verify: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    )
    const repo: RepoContext = {
      mainRoot: ctx.root,
      config,
      backlogDir,
      metricsPath: ctx.metricsPath,
      agents,
    }
    const resolver = fixtureResolver(ctx, repo)

    expect(await resolveNames(resolver, { kind: 'backlog-id' }, ['backlog', 'rm', ''])).toEqual([
      { name: 'fix-header', description: 'Fix the header' },
    ])
  })
})

describe('runComplete hardening (subprocess)', () => {
  type CliResult = { stdout: string; stderr: string; code: number }

  async function runHelper(
    args: string[],
    cwd: string,
    env: Record<string, string>
  ): Promise<CliResult> {
    const merged: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        merged[key] = value
      }
    }
    Object.assign(merged, env)
    const proc = Bun.spawn(['bun', cliPath, '__complete', ...args], {
      cwd,
      env: merged,
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

  async function gitRepo(prefix: string): Promise<string> {
    const dir = await tempDir(prefix)
    const proc = Bun.spawn(['git', 'init', '-q', dir], { stdout: 'pipe', stderr: 'pipe' })
    expect(await proc.exited).toBe(0)
    return dir
  }

  test('no factory state, non-git cwd: exits 0 with command candidates, silent stderr', async () => {
    const cwd = await tempDir('complete-nostate')
    const home = await tempDir('complete-nostate-home')

    const commands = await runHelper(['0'], cwd, { FACTORY_HOME: home })
    expect(commands.code).toBe(0)
    expect(commands.stderr).toBe('')
    expect(commands.stdout).toContain('add\t')
    expect(commands.stdout).toContain('dispatch\t')

    // A dynamic-source position outside a repo: still exit 0, just no candidates
    // beyond the level's options.
    const dynamic = await runHelper(['1', 'show', ''], cwd, { FACTORY_HOME: home })
    expect(dynamic.code).toBe(0)
    expect(dynamic.stderr).toBe('')

    expect(await readdir(home)).toEqual([])
  })

  test('malformed args and unknown commands are silent successes', async () => {
    const cwd = await tempDir('complete-badargs')
    const home = await tempDir('complete-badargs-home')
    for (const args of [[], ['x'], ['-3'], ['5', 'wat', 'wat']]) {
      const result = await runHelper(args, cwd, { FACTORY_HOME: home })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
    }
  })

  test('corrupt task meta: helper still completes the healthy task ids', async () => {
    const repo = await gitRepo('complete-corrupt')
    const home = await tempDir('complete-corrupt-home')
    const toplevel = Bun.spawn(['git', '-C', repo, 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe',
    })
    const root = (await new Response(toplevel.stdout).text()).trim()
    const worktreeKey = root.replace(/\//g, '-').replace(/^-+/, '')
    const tasksDir = `${home}/sessions/${worktreeKey}/tasks`
    await mkdir(`${tasksDir}/good-task`, { recursive: true })
    await writeFile(
      `${tasksDir}/good-task/meta.json`,
      JSON.stringify({
        id: 'good-task',
        slug: 'good-task',
        status: 'blocked',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    )
    await mkdir(`${tasksDir}/broken-task`, { recursive: true })
    await writeFile(`${tasksDir}/broken-task/meta.json`, '{definitely not json')

    const result = await runHelper(['1', 'retry', ''], repo, { FACTORY_HOME: home })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('good-task\tblocked')
    expect(result.stdout).not.toContain('broken-task')
  })

  test('hostile lesson text cannot corrupt the tab-separated line protocol', async () => {
    const repo = await gitRepo('complete-hostile')
    const home = await tempDir('complete-hostile-home')
    await mkdir(`${home}/guidance/items`, { recursive: true })
    await writeFile(
      `${home}/guidance/items/lesson.json`,
      JSON.stringify({
        id: 'hostile-lesson',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        source: { kind: 'manual', taskId: null, detail: null },
        scope: { kind: 'global' },
        stages: ['implement'],
        text:
          'evil\tinjected\ncandidate:with colons\r and \u001b[31mred\u001b[0m then ' +
          '\u001b]0;title\u0007osc \u009b31mc1 \u001b(Bcharset nul\u0000end',
      })
    )

    const result = await runHelper(['2', 'lessons', 'show', ''], repo, { FACTORY_HOME: home })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const lines = result.stdout.split('\n').filter((line) => line.length > 0)
    const lesson = lines.find((line) => line.startsWith('hostile-lesson'))
    expect(lesson).toBeDefined()
    // ANSI/OSC/charset escape sequences are removed whole (no leftover '[31m'
    // junk), other control characters flatten to spaces, framing survives.
    expect(lesson).toContain('and red then osc c1 charset nul end')
    for (const line of lines) {
      expect(line.split('\t')).toHaveLength(2)
      expect(line).not.toContain('\r')
      expect(line).not.toContain('\u001b')
      expect(line).not.toContain('\u009b')
      expect(line).not.toContain('\u0000')
      expect(line).not.toContain('[31m')
    }
  })
})
