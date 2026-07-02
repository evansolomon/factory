import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { $ } from 'bun'
import { ConfigError, loadConfig, loadContext, normalizeOrigin, repoKey } from '../src/config.ts'

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

  test('warns and ignores unknown keys instead of failing', async () => {
    await withFactoryHome(async () => {
      const root = await tempDir('unknown-key')
      await writeJson(`${root}/.factory.json`, { onComplete: ['echo done'], retries: 5 })

      // An unknown key (here a removed one) must not abort the run (which mid-`add`
      // would discard a just-typed task intent); the rest of the file still applies
      // and the key is dropped from the resolved config.
      const config = await loadConfig(root)

      expect(config.retries).toBe(5)
      expect('onComplete' in config).toBe(false)
    })
  })

  test('rejects codex-only agent options on claude agents', async () => {
    await withFactoryHome(async () => {
      const root = await tempDir('invalid-agent')
      await writeJson(`${root}/.factory.json`, {
        agents: { reviewer: { cli: 'claude', reasoningEffort: 'low' } },
      })

      await expect(loadConfig(root)).rejects.toThrow(ConfigError)
      await expect(loadConfig(root)).rejects.toThrow(
        'reasoningEffort is only supported for the codex cli'
      )
    })
  })

  test('configures the ask agent separately from pipeline agents', async () => {
    await withFactoryHome(async () => {
      const root = await tempDir('ask-agent')

      expect((await loadConfig(root)).ask.agent).toBe('claude')
      expect((await loadConfig(root)).agents.namer).toEqual({
        cli: 'codex',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'low',
      })

      await writeJson(`${root}/.factory.json`, {
        agents: { reviewer: 'codex', namer: { cli: 'codex', model: 'gpt-5.4-mini' } },
        ask: { agent: { cli: 'codex', model: 'gpt-5.4' } },
      })

      const config = await loadConfig(root)

      expect(config.agents.reviewer).toBe('codex')
      expect(config.agents.namer).toEqual({ cli: 'codex', model: 'gpt-5.4-mini' })
      expect(config.ask.agent).toEqual({ cli: 'codex', model: 'gpt-5.4' })
    })
  })

  test('configures workforce routing agents and specialist policies', async () => {
    await withFactoryHome(async () => {
      const root = await tempDir('workforce-config')
      await writeJson(`${root}/.factory.json`, {
        workforce: true,
        rescue: true,
        agents: {
          workforce: { cli: 'codex', model: 'gpt-5.4-mini', reasoningEffort: 'low' },
          rescue: 'claude',
          researchers: { runtime: 'claude' },
          reviewers: { deploy: { cli: 'codex', model: 'gpt-5.4' } },
        },
        specialists: {
          deploy: {
            path: 'policies/deploy.md',
            description: 'Deploy safety policy',
            appliesTo: ['review.deploy', 'research.runtime'],
          },
        },
      })

      const config = await loadConfig(root)

      expect(config.agents.workforce).toEqual({
        cli: 'codex',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'low',
      })
      expect(config.agents.researchers['runtime']).toBe('claude')
      expect(config.agents.reviewers['deploy']).toEqual({ cli: 'codex', model: 'gpt-5.4' })
      expect(config.specialists['deploy']).toEqual({
        path: 'policies/deploy.md',
        description: 'Deploy safety policy',
        appliesTo: ['review.deploy', 'research.runtime'],
      })
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

describe('repo identity', () => {
  test('normalizes the common origin URL shapes to one canonical form', () => {
    const canonical = 'github.com/evansolomon/factory'
    expect(normalizeOrigin('https://github.com/evansolomon/factory.git')).toBe(canonical)
    expect(normalizeOrigin('https://user:token@GitHub.com/evansolomon/factory.git')).toBe(canonical)
    expect(normalizeOrigin('ssh://git@github.com/evansolomon/factory')).toBe(canonical)
    expect(normalizeOrigin('ssh://git@github.com:22/evansolomon/factory.git')).toBe(canonical)
    expect(normalizeOrigin('git@github.com:evansolomon/factory.git')).toBe(canonical)
    expect(normalizeOrigin('git://github.com/evansolomon/factory')).toBe(canonical)
    expect(normalizeOrigin('https://gitlab.com/group/sub/project.git')).toBe(
      'gitlab.com/group/sub/project'
    )
  })

  test('rejects unusable origin values', () => {
    expect(normalizeOrigin('')).toBeNull()
    expect(normalizeOrigin('not-a-url')).toBeNull()
    expect(normalizeOrigin('https://hostonly')).toBeNull()
  })

  test('repoKey uses the normalized origin and falls back to the path key', () => {
    expect(repoKey('git@github.com:evansolomon/factory.git', '/data/repos/factory')).toBe(
      'github.com-evansolomon-factory'
    )
    expect(repoKey(null, '/data/repos/factory')).toBe('data-repos-factory')
    expect(repoKey('not-a-url', '/data/repos/factory')).toBe('data-repos-factory')
  })

  test('repo state lives under repos/<origin-key> regardless of checkout path', async () => {
    await withFactoryHome(async (home) => {
      const base = await tempDir('origin-repo')
      const root = `${base}/repo`
      await mkdir(root, { recursive: true })
      await $`git -C ${root} init`.quiet()
      await $`git -C ${root} remote add origin git@github.com:evansolomon/factory.git`.quiet()

      const ctx = await loadContext(root)

      expect(ctx.repoStateDir).toBe(`${home}/repos/github.com-evansolomon-factory`)
      expect(ctx.metricsPath).toBe(`${home}/repos/github.com-evansolomon-factory/metrics.db`)
      // Per-worktree session state still keys by path — worktrees ARE local.
      expect(ctx.stateDir.startsWith(`${home}/sessions/`)).toBe(true)
    })
  })

  test('repo state falls back to the path key without an origin remote', async () => {
    await withFactoryHome(async (home) => {
      const base = await tempDir('no-origin')
      const root = `${base}/repo`
      await mkdir(root, { recursive: true })
      await $`git -C ${root} init`.quiet()

      const ctx = await loadContext(root)
      const key = ctx.root.replace(/\//g, '-').replace(/^-+/, '')

      expect(ctx.repoStateDir).toBe(`${home}/repos/${key}`)
    })
  })
})

describe('cascade deep-merge for agents and specialists', () => {
  test('a partial agents override does not reset sibling roles', async () => {
    await withFactoryHome(async (home) => {
      const base = await tempDir('agents-merge')
      const root = `${base}/repo`
      await mkdir(root, { recursive: true })
      await writeJson(`${home}/config.json`, {
        agents: {
          reviewer: { cli: 'codex', model: 'gpt-5.4' },
          researchers: { runtime: 'claude' },
        },
      })
      await writeJson(`${root}/.factory.json`, {
        agents: { implementer: 'claude', researchers: { history: 'codex' } },
      })

      const config = await loadConfig(root)

      expect(config.agents.implementer).toBe('claude')
      // Sibling role from the lower layer survives the partial override.
      expect(config.agents.reviewer).toEqual({ cli: 'codex', model: 'gpt-5.4' })
      // Nested pools merge per key too.
      expect(config.agents.researchers).toEqual({ runtime: 'claude', history: 'codex' })
      // Untouched roles still default.
      expect(config.agents.planners).toEqual(['codex', 'claude'])
    })
  })

  test('specialists merge per policy name across the cascade', async () => {
    await withFactoryHome(async (home) => {
      const base = await tempDir('specialists-merge')
      const root = `${base}/repo`
      await mkdir(root, { recursive: true })
      await writeJson(`${home}/config.json`, {
        specialists: { deploy: { path: 'policies/deploy.md' } },
      })
      await writeJson(`${root}/.factory.json`, {
        specialists: { security: { path: 'policies/security.md' } },
      })

      const config = await loadConfig(root)

      expect(Object.keys(config.specialists).sort()).toEqual(['deploy', 'security'])
    })
  })
})
