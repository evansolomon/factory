import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  agentSessionCommand,
  agentSessionPrompt,
  buildAgentSessionHandoff,
  parseAgentSessionArgs,
} from '../src/agent-session.ts'
import type { Config, RoleAgents, WorkContext } from '../src/config.ts'
import { addTask, writeArtifact } from '../src/task.ts'

const config: Config = {
  retries: 10,
  triage: true,
  security: true,
  ux: true,
  plansDir: null,
  captureEvals: false,
  postmortem: false,
  remediate: true,
  hooks: {},
  agents: {
    planners: ['codex', 'claude'],
    implementer: 'codex',
    reviewer: 'claude',
    delivery: 'claude',
  },
  ask: { agent: 'claude' },
}

const agents: RoleAgents = {
  planners: [{ cli: 'codex' }, { cli: 'claude' }],
  implementer: { cli: 'codex' },
  reviewer: { cli: 'claude' },
  delivery: { cli: 'claude' },
}

async function workContext(): Promise<WorkContext> {
  const root = await mkdtemp(`${tmpdir()}/factory-agent-session-`)
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

describe('parseAgentSessionArgs', () => {
  test('defaults to the supplied agent and accepts an optional task id', () => {
    expect(parseAgentSessionArgs(['fix-button'], 'codex')).toEqual({
      ok: true,
      request: { agent: 'codex', taskQuery: 'fix-button' },
    })
  })

  test('supports selecting claude', () => {
    expect(parseAgentSessionArgs(['--agent', 'claude'], 'codex')).toEqual({
      ok: true,
      request: { agent: 'claude', taskQuery: null },
    })
  })
})

describe('buildAgentSessionHandoff', () => {
  test('writes a manifest with task metadata and existing artifact references', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Tweak the completed UI', 'bun test')
    task.meta.status = 'done'
    task.meta.commit = 'abc1234'
    await writeArtifact(task, 'plan.md', 'Use the existing component.')
    await writeArtifact(task, 'verify.log', '$ bun test\npassed')
    await writeArtifact(task, 'implement.activity.jsonl', '{"type":"turn.completed"}')
    await writeArtifact(task, 'agent-session.summary.md', 'Prior summary')

    const handoff = await buildAgentSessionHandoff(
      ctx,
      task,
      'claude',
      new Date('2026-06-22T12:00:00.000Z')
    )

    expect(handoff.artifact).toBe(`${task.dir}/agent-session.md`)
    expect(handoff.summaryPath).toBe(`${task.dir}/agent-session.summary.md`)
    expect(handoff.content).toContain('Generated: 2026-06-22T12:00:00.000Z')
    expect(handoff.content).toContain(`- id: ${task.id}`)
    expect(handoff.content).toContain('- status: done')
    expect(handoff.content).toContain('- agent: claude')
    expect(handoff.content).toContain('- commit: abc1234')
    expect(handoff.content).toContain(`- task.md: ${task.dir}/task.md`)
    expect(handoff.content).toContain(`- plan.md: ${task.dir}/plan.md`)
    expect(handoff.content).toContain(`- verify.log: ${task.dir}/verify.log`)
    expect(handoff.content).toContain(
      `- implement.activity.jsonl: ${task.dir}/implement.activity.jsonl`
    )
    expect(handoff.content).not.toContain('agent-session.summary.md:')
    expect(handoff.content).not.toContain('ship.md:')
    expect(await Bun.file(handoff.artifact).text()).toBe(handoff.content)
  })
})

describe('agentSessionCommand', () => {
  test('opens interactive codex with workspace-write and approval prompts', () => {
    const cmd = agentSessionCommand({
      agent: 'codex',
      root: '/repo',
      taskId: 'fix-button',
      handoffPath: '/state/tasks/fix-button/agent-session.md',
      summaryPath: '/state/tasks/fix-button/agent-session.summary.md',
    })

    expect(cmd.slice(0, 7)).toEqual([
      'codex',
      '-C',
      '/repo',
      '-s',
      'workspace-write',
      '-a',
      'on-request',
    ])
    expect(cmd[7]).toBe(
      agentSessionPrompt({
        taskId: 'fix-button',
        handoffPath: '/state/tasks/fix-button/agent-session.md',
        summaryPath: '/state/tasks/fix-button/agent-session.summary.md',
      })
    )
  })

  test('opens interactive claude in the task worktree', () => {
    const cmd = agentSessionCommand({
      agent: 'claude',
      root: '/repo',
      taskId: 'fix-button',
      handoffPath: '/state/tasks/fix-button/agent-session.md',
      summaryPath: '/state/tasks/fix-button/agent-session.summary.md',
    })

    expect(cmd.slice(0, 5)).toEqual([
      'claude',
      '--add-dir',
      '/repo',
      '--permission-mode',
      'default',
    ])
    expect(cmd[5]).toBe(
      agentSessionPrompt({
        taskId: 'fix-button',
        handoffPath: '/state/tasks/fix-button/agent-session.md',
        summaryPath: '/state/tasks/fix-button/agent-session.summary.md',
      })
    )
  })
})
