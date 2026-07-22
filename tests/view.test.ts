import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Config, RoleAgents, WorkContext } from '../src/config.ts'
import { createDispatchChain, updateDispatchChain } from '../src/dispatch-chain.ts'
import { log } from '../src/log.ts'
import { writePrototypeOutput } from '../src/prototype.ts'
import { addTask, saveMeta, setStatus } from '../src/task.ts'
import { printShow, printStatus } from '../src/view.ts'

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
  const root = await mkdtemp(`${tmpdir()}/factory-view-`)
  const initialized = Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  if (initialized.exitCode !== 0) {
    throw new Error('could not initialize status test repository')
  }
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

async function captureLog(work: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = { ...log }
  log.log = (message: string) => lines.push(message)
  log.info = (message: string) => lines.push(message)
  log.fail = (message: string) => lines.push(message)
  log.warn = (message: string) => lines.push(message)
  log.step = (message: string) => lines.push(message)
  log.ok = (message: string) => lines.push(message)
  log.done = (message: string) => lines.push(message)
  try {
    await work()
  } finally {
    log.log = original.log
    log.info = original.info
    log.fail = original.fail
    log.warn = original.warn
    log.step = original.step
    log.ok = original.ok
    log.done = original.done
  }
  return lines
}

describe('printShow', () => {
  test('prints prototype summary and primary artifact pointer without inlining HTML', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Show prototype', null)
    await writePrototypeOutput(
      task,
      [
        'PROTOTYPE: YES',
        'ARTIFACT: mock.html',
        'REASON: clarify UI risk',
        '--- BEGIN ARTIFACT ---',
        '<html>do not inline</html>',
        '--- END ARTIFACT ---',
      ].join('\n')
    )

    const lines = await captureLog(async () => {
      await printShow(ctx, task.id)
    })
    const output = lines.join('\n')

    expect(output).toContain('## Prototype')
    expect(output).toContain('Decision: created')
    expect(output).toContain('prototype artifact: file://')
    expect(output).toContain('/prototype-artifacts/mock.html')
    expect(output).not.toContain('do not inline')
  })
})

describe('printStatus', () => {
  test('renders delegated ownership as settled instead of active closed work', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Parent task', null)
    await setStatus(task, 'delegated', 'delegated to 3 serial workstreams (parent-abcd1234)')

    const lines = await captureLog(async () => {
      await printStatus(ctx)
    })
    const output = lines.join('\n')

    expect(output).toContain('⇢ delegated (1)')
    expect(output).toContain('delegated to 3 serial workstreams')
    expect(output).not.toContain('▶ now:')
  })

  test('renders v0.2.11 closed delegation records as delegated', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Legacy parent', null)
    await setStatus(task, 'closed', 'delegated to 7 serial workstreams (parent-abcd1234)')

    const lines = await captureLog(async () => {
      await printStatus(ctx)
    })

    expect(lines.join('\n')).toContain('⇢ delegated (1)')
  })

  test('shows the active child from durable chain state', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Parent task', null)
    task.meta.dispatchChainId = 'parent-abcd1234'
    await saveMeta(task)
    await setStatus(task, 'delegated', 'delegated')
    await createDispatchChain(ctx.repoStateDir, {
      id: 'parent-abcd1234',
      parentTaskId: task.id,
      units: ['child-one'],
    })
    await updateDispatchChain(ctx.repoStateDir, 'parent-abcd1234', {
      currentUnit: 'child-one',
      status: 'running',
    })

    const lines = await captureLog(async () => {
      await printStatus(ctx)
    })

    expect(lines.join('\n')).toContain(`${task.id} — running at child-one`)
  })
})
