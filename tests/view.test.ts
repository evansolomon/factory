import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Config, RoleAgents, WorkContext } from '../src/config.ts'
import { log } from '../src/log.ts'
import { writePrototypeOutput } from '../src/prototype.ts'
import { addTask } from '../src/task.ts'
import { printShow } from '../src/view.ts'

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
