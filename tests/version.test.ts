import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { FACTORY_VERSION, resolveFactoryVersion } from '../src/version.ts'

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
  for (const [key, value] of Object.entries(values)) {
    env[key] = value
  }
  return env
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

describe('version commands', () => {
  test('resolveFactoryVersion uses a build version when present', () => {
    expect(resolveFactoryVersion({ FACTORY_BUILD_VERSION: '0.1.1-dev.20260621010203' })).toBe(
      '0.1.1-dev.20260621010203'
    )
  })

  test('factory --version works outside a git repo without touching FACTORY_HOME', async () => {
    const cwd = await tempDir('version-cwd')
    const home = await tempDir('version-home')
    const result = await runFactory(['--version'], cwd, envWith({ FACTORY_HOME: home }))

    expect(result).toEqual({ stdout: `${FACTORY_VERSION}\n`, stderr: '', code: 0 })
    expect(await readdir(home)).toEqual([])
  })

  test('factory version works outside a git repo without touching FACTORY_HOME', async () => {
    const cwd = await tempDir('version-cwd')
    const home = await tempDir('version-home')
    const result = await runFactory(['version'], cwd, envWith({ FACTORY_HOME: home }))

    expect(result).toEqual({ stdout: `${FACTORY_VERSION}\n`, stderr: '', code: 0 })
    expect(await readdir(home)).toEqual([])
  })
})
