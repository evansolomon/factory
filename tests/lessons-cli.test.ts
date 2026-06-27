import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { type GuidanceRecord, GuidanceRecordSchema } from '../src/guidance.ts'

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

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
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

async function repoDir(): Promise<string> {
  const root = await tempDir('lessons-cli-repo')
  const result = await runCommand(['git', 'init'], root, envWith({}))
  expect(result.code).toBe(0)
  return root
}

async function runFactory(args: string[], cwd: string, home: string): Promise<CliResult> {
  return await runCommand(['bun', cliPath, ...args], cwd, envWith({ FACTORY_HOME: home }))
}

function record(input: { id: string; text: string }): GuidanceRecord {
  return GuidanceRecordSchema.parse({
    id: input.id,
    createdAt: '2026-06-25T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
    source: { kind: 'manual', taskId: null, detail: null },
    scope: { kind: 'global' },
    stages: ['plan'],
    tags: [],
    text: input.text,
    rationale: null,
    status: 'active',
    deletedAt: null,
  })
}

async function writeRecord(home: string, value: GuidanceRecord): Promise<void> {
  const dir = `${home}/guidance/items`
  await mkdir(dir, { recursive: true })
  await Bun.write(`${dir}/${value.id}.json`, `${JSON.stringify(value, null, 2)}\n`)
}

describe('factory lessons CLI', () => {
  test('lessons list exits 0 on empty guidance', async () => {
    const cwd = await repoDir()
    const home = await tempDir('lessons-cli-home')

    const result = await runFactory(['lessons', 'list'], cwd, home)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      'no learned lessons yet - corrections become lessons automatically'
    )
    expect(result.stdout).toContain('## Legacy LESSONS.md')
    expect(result.stderr).toBe('')
  })

  test('lessons show prints one record', async () => {
    const cwd = await repoDir()
    const home = await tempDir('lessons-cli-home')
    await writeRecord(home, record({ id: 'abc111', text: 'Prefer parser APIs.' }))

    const result = await runFactory(['lessons', 'show', 'abc'], cwd, home)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('abc111 [active]')
    expect(result.stdout).toContain('Prefer parser APIs.')
  })

  test('lessons rm refuses ambiguous partial ids', async () => {
    const cwd = await repoDir()
    const home = await tempDir('lessons-cli-home')
    await writeRecord(home, record({ id: 'abc111', text: 'First.' }))
    await writeRecord(home, record({ id: 'abc222', text: 'Second.' }))

    const result = await runFactory(['lessons', 'rm', 'abc'], cwd, home)

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('ambiguous lesson id "abc"')
    expect(result.stdout).toContain('abc111')
    expect(result.stdout).toContain('abc222')
  })

  test('lessons edit updates text', async () => {
    const cwd = await repoDir()
    const home = await tempDir('lessons-cli-home')
    await writeRecord(home, record({ id: 'abc111', text: 'Old text.' }))

    const result = await runFactory(['lessons', 'edit', 'abc111', '-m', 'New text.'], cwd, home)
    const stored = GuidanceRecordSchema.parse(
      await Bun.file(`${home}/guidance/items/abc111.json`).json()
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('lessons abc111 (updated)')
    expect(stored.text).toBe('New text.')
  })

  test('lessons edit updates scope and stages', async () => {
    const cwd = await repoDir()
    const home = await tempDir('lessons-cli-home')
    await writeRecord(home, record({ id: 'abc111', text: 'Keep text.' }))

    const result = await runFactory(
      ['lessons', 'edit', 'abc111', '--scope', 'repo', '--stage', 'plan', '--stage', 'review'],
      cwd,
      home
    )
    const stored = GuidanceRecordSchema.parse(
      await Bun.file(`${home}/guidance/items/abc111.json`).json()
    )

    expect(result.code).toBe(0)
    expect(stored.scope.kind).toBe('repo')
    expect(stored.stages).toEqual(['plan', 'review'])
  })
})
