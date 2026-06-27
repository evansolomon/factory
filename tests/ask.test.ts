import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { AgentRun } from '../src/agents.ts'
import {
  answerAskQuestion,
  askSessionTtyError,
  buildAskPrompt,
  NON_TTY_ASK_MESSAGE,
  parseAskRequest,
  runAskSession,
} from '../src/ask.ts'
import type { Agent, Config, RoleAgents, WorkContext } from '../src/config.ts'
import { addTask } from '../src/task.ts'

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
    namer: { cli: 'codex', model: 'gpt-5-nano' },
  },
  ask: { agent: 'claude' },
}

const agents: RoleAgents = {
  planners: [{ cli: 'codex' }, { cli: 'claude' }],
  implementer: { cli: 'codex' },
  reviewer: { cli: 'claude' },
  delivery: { cli: 'claude' },
  namer: { cli: 'codex', model: 'gpt-5-nano' },
}

async function workContext(): Promise<WorkContext> {
  const root = await mkdtemp(`${tmpdir()}/factory-ask-`)
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

function readLines(lines: string[]): () => Promise<string> {
  let index = 0
  return async () => {
    const line = lines[index] ?? ''
    index += 1
    return line
  }
}

describe('parseAskRequest', () => {
  test('leading --print selects print mode and resolves task substrings', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Ship the thing', null)

    expect(parseAskRequest(['--print', 'ship', 'has ship ran?'], [task])).toEqual({
      mode: 'print',
      taskId: task.id,
      question: 'has ship ran?',
    })
  })

  test('non-leading --print remains part of the question', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Existing task', null)

    expect(parseAskRequest(['what', '--print', 'means'], [task])).toEqual({
      mode: 'session',
      taskId: null,
      question: 'what --print means',
    })
  })

  test('task id with no question opens a scoped session request', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Scoped task', null)

    expect(parseAskRequest([task.id], [task])).toEqual({
      mode: 'session',
      taskId: task.id,
      question: '',
    })
  })
})

describe('buildAskPrompt', () => {
  test('empty transcript keeps one-shot structure without conversation history', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Explain status', null)
    const prompt = buildAskPrompt('what happened?', ctx, [task], [])

    expect(prompt).toContain("You are answering a question about factory's saved task state.")
    expect(prompt).toContain('User question:\nwhat happened?')
    expect(prompt).not.toContain('Conversation history')
    expect(prompt).not.toContain('Use the conversation history only')
  })

  test('non-empty transcript adds continuity history and evidence-boundary rules', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Explain status', null)
    const prompt = buildAskPrompt(
      'why?',
      ctx,
      [task],
      [],
      [{ question: 'what failed?', answer: 'verify failed' }]
    )

    expect(prompt).toContain('Conversation history (live session memory, not saved evidence):')
    expect(prompt).toContain('Human: what failed?')
    expect(prompt).toContain('Assistant: verify failed')
    expect(prompt).toContain('Use the conversation history only to resolve references')
    expect(prompt).toContain('current saved state wins')
  })
})

describe('answerAskQuestion', () => {
  test('one-shot compatible path calls the agent once with read access', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Check ship', null)
    const calls: { agent: Agent; opts: AgentRun }[] = []

    const result = await answerAskQuestion({
      ctx,
      taskId: null,
      question: 'has ship ran?',
      runner: async (agent, opts) => {
        calls.push({ agent, opts })
        return { text: '  no ship artifact  ', usage: { inputTokens: 1, outputTokens: 2 } }
      },
    })

    expect(result).toEqual({ answer: 'no ship artifact', selectedTaskIds: [task.id] })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.agent).toEqual({ cli: 'claude' })
    expect(calls[0]?.opts.access).toBe('read')
    expect(calls[0]?.opts.prompt).toContain('User question:\nhas ship ran?')
  })

  test('follow-up turns include transcript and carried task ids from fresh task state', async () => {
    const ctx = await workContext()
    await addTask(ctx, 'Alpha', null)
    await addTask(ctx, 'Beta', null)
    await addTask(ctx, 'Gamma', null)
    await addTask(ctx, 'Delta', null)
    const carried = await addTask(ctx, 'Epsilon carried task', null)
    const prompts: string[] = []

    await answerAskQuestion({
      ctx,
      taskId: null,
      question: 'why?',
      transcript: [{ question: 'what about epsilon?', answer: 'epsilon was selected' }],
      carriedTaskIds: [carried.id],
      runner: async (_agent, opts) => {
        prompts.push(opts.prompt)
        return { text: 'answer', usage: { inputTokens: 0, outputTokens: 0 } }
      },
    })

    expect(prompts[0]).toContain('Human: what about epsilon?')
    expect(prompts[0]).toContain(`### ${carried.id}/meta.json`)
  })

  test('scoped task disappearance fails instead of widening to all tasks', async () => {
    const ctx = await workContext()
    const scoped = await addTask(ctx, 'Scoped task', null)
    await addTask(ctx, 'Other task', null)
    await rm(scoped.dir, { recursive: true, force: true })

    await expect(
      answerAskQuestion({
        ctx,
        taskId: scoped.id,
        question: 'what happened?',
        runner: async () => ({
          text: 'should not run',
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      })
    ).rejects.toThrow(`task ${scoped.id} is no longer in this worktree`)
  })
})

describe('runAskSession', () => {
  test('seeded question is sent before reading follow-up input', async () => {
    const questions: string[] = []
    let reads = 0

    const code = await runAskSession({
      agent: 'claude',
      taskId: null,
      initialQuestion: 'first question',
      readLine: async () => {
        reads += 1
        return '/done'
      },
      write: () => {},
      writeError: () => {},
      turn: async (question) => {
        questions.push(question)
        return { kind: 'answer', answer: 'answer', selectedTaskIds: [] }
      },
    })

    expect(code).toBe(0)
    expect(questions).toEqual(['first question'])
    expect(reads).toBe(1)
  })

  test('follow-up turns receive prior transcript and carried selected task ids', async () => {
    const seen: { question: string; transcriptLength: number; carriedTaskIds: string[] }[] = []

    const code = await runAskSession({
      agent: 'claude',
      taskId: null,
      initialQuestion: 'what failed?',
      readLine: readLines(['why?', '/done']),
      write: () => {},
      writeError: () => {},
      turn: async (question, transcript, carriedTaskIds) => {
        seen.push({ question, transcriptLength: transcript.length, carriedTaskIds })
        return {
          kind: 'answer',
          answer: `${question} answer`,
          selectedTaskIds: question === 'what failed?' ? ['task-a'] : [],
        }
      },
    })

    expect(code).toBe(0)
    expect(seen).toEqual([
      { question: 'what failed?', transcriptLength: 0, carriedTaskIds: [] },
      { question: 'why?', transcriptLength: 1, carriedTaskIds: ['task-a'] },
    ])
  })

  test('empty input and /done exit cleanly', async () => {
    expect(
      await runAskSession({
        agent: 'claude',
        taskId: null,
        initialQuestion: '',
        readLine: readLines(['']),
        write: () => {},
        writeError: () => {},
        turn: async () => ({ kind: 'answer', answer: 'unused', selectedTaskIds: [] }),
      })
    ).toBe(0)

    expect(
      await runAskSession({
        agent: 'claude',
        taskId: null,
        initialQuestion: '',
        readLine: readLines(['/done']),
        write: () => {},
        writeError: () => {},
        turn: async () => ({ kind: 'answer', answer: 'unused', selectedTaskIds: [] }),
      })
    ).toBe(0)
  })

  test('/cancel exits nonzero', async () => {
    const code = await runAskSession({
      agent: 'claude',
      taskId: null,
      initialQuestion: '',
      readLine: readLines(['/cancel']),
      write: () => {},
      writeError: () => {},
      turn: async () => ({ kind: 'answer', answer: 'unused', selectedTaskIds: [] }),
    })

    expect(code).toBe(1)
  })

  test('Ctrl-C exits cleanly with visible feedback', async () => {
    const lines: string[] = []

    const code = await runAskSession({
      agent: 'claude',
      taskId: null,
      initialQuestion: '',
      readLine: async () => null,
      write: (text) => lines.push(text),
      writeError: () => {},
      turn: async () => ({ kind: 'answer', answer: 'unused', selectedTaskIds: [] }),
    })

    expect(code).toBe(0)
    expect(lines).toContain('  interrupted')
  })

  test('turn failure reports an error, skips transcript append, and re-prompts', async () => {
    const errors: string[] = []
    const transcriptLengths: number[] = []

    const code = await runAskSession({
      agent: 'claude',
      taskId: null,
      initialQuestion: '',
      readLine: readLines(['bad', 'retry', '/done']),
      write: () => {},
      writeError: (text) => errors.push(text),
      turn: async (question, transcript) => {
        transcriptLengths.push(transcript.length)
        if (question === 'bad') {
          throw new Error('agent exploded')
        }
        return { kind: 'answer', answer: 'ok', selectedTaskIds: [] }
      },
    })

    expect(code).toBe(0)
    expect(errors).toEqual(['ask failed: agent exploded'])
    expect(transcriptLengths).toEqual([0, 0])
  })

  test('fatal turn ends the session nonzero', async () => {
    const errors: string[] = []

    const code = await runAskSession({
      agent: 'claude',
      taskId: 'missing',
      initialQuestion: 'what happened?',
      readLine: readLines(['/done']),
      write: () => {},
      writeError: (text) => errors.push(text),
      turn: async () => ({ kind: 'fatal', message: 'task missing is no longer in this worktree' }),
    })

    expect(code).toBe(1)
    expect(errors).toEqual(['task missing is no longer in this worktree'])
  })
})

describe('askSessionTtyError', () => {
  test('non-TTY session mode points users to --print', () => {
    expect(askSessionTtyError(false, true)).toBe(NON_TTY_ASK_MESSAGE)
    expect(askSessionTtyError(true, false)).toBe(NON_TTY_ASK_MESSAGE)
    expect(askSessionTtyError(true, true)).toBeNull()
  })
})
