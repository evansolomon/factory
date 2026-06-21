import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { $ } from 'bun'
import { ConfigError, loadConfig, loadContext } from '../src/config.ts'

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(`${tmpdir()}/factory-${prefix}-`)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function withFactoryHome<T>(work: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env['FACTORY_HOME']
  const home = await tempDir('home')
  process.env['FACTORY_HOME'] = home
  try {
    return await work(home)
  } finally {
    if (previous === undefined) {
      delete process.env['FACTORY_HOME']
    } else {
      process.env['FACTORY_HOME'] = previous
    }
  }
}

describe('config cascade', () => {
  test('applies global, ancestor, and worktree precedence with concatenated hooks', async () => {
    await withFactoryHome(async (home) => {
      const base = await tempDir('config')
      const root = `${base}/repo`
      await mkdir(root, { recursive: true })
      await writeJson(`${home}/config.json`, {
        retries: 1,
        hooks: { 'stage.change': ['global-stage'], attention: ['global-attention'] },
      })
      await writeJson(`${base}/.factory.json`, {
        retries: 2,
        security: false,
        hooks: { 'stage.change': ['ancestor-stage'] },
      })
      await writeJson(`${root}/.factory.json`, {
        retries: 3,
        hooks: {
          'stage.change': ['worktree-stage', 'ancestor-stage'],
          'task.done': ['worktree-done'],
        },
      })

      const config = await loadConfig(root)

      expect(config.retries).toBe(3)
      expect(config.security).toBe(false)
      expect(config.hooks['stage.change']).toEqual([
        'global-stage',
        'ancestor-stage',
        'worktree-stage',
      ])
      expect(config.hooks['attention']).toEqual(['global-attention'])
      expect(config.hooks['task.done']).toEqual(['worktree-done'])
    })
  })

  test('fails invalid JSON config explicitly', async () => {
    await withFactoryHome(async () => {
      const root = await tempDir('invalid-json')
      await Bun.write(`${root}/.factory.json`, '{ bad json')

      await expect(loadConfig(root)).rejects.toThrow(ConfigError)
      await expect(loadConfig(root)).rejects.toThrow('invalid JSON config')
    })
  })

  test('fails invalid hook shape explicitly', async () => {
    await withFactoryHome(async () => {
      const root = await tempDir('invalid-hooks')
      await writeJson(`${root}/.factory.json`, { hooks: { 'stage.change': 'not an array' } })

      await expect(loadConfig(root)).rejects.toThrow(ConfigError)
      await expect(loadConfig(root)).rejects.toThrow('invalid .factory.json config')
    })
  })

  test('resolves the default state directory under FACTORY_HOME sessions', async () => {
    await withFactoryHome(async (home) => {
      const base = await tempDir('repo')
      const root = `${base}/repo`
      await mkdir(root, { recursive: true })
      await $`git -C ${root} init`.quiet()

      const ctx = await loadContext(root)
      const key = ctx.root.replace(/\//g, '-').replace(/^-+/, '')

      expect(ctx.stateDir).toBe(`${home}/sessions/${key}`)
      expect(ctx.tasksDir).toBe(`${home}/sessions/${key}/tasks`)
    })
  })
})
