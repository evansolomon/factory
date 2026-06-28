import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Config, RoleAgents, WorkContext } from '../src/config.ts'
import {
  parsePrototypeOutput,
  prototypeContext,
  prototypePrimaryArtifactPath,
  readPrototypeManifest,
  writePrototypeOutput,
} from '../src/prototype.ts'
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
  const root = await mkdtemp(`${tmpdir()}/factory-prototype-`)
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

function validYes(name = 'flow.html', body = '<!doctype html>\n<html></html>'): string {
  return [
    'PROTOTYPE: YES',
    `ARTIFACT: ${name}`,
    'REASON: clarify the interaction before implementation',
    '--- BEGIN ARTIFACT ---',
    body,
    '--- END ARTIFACT ---',
  ].join('\n')
}

describe('parsePrototypeOutput', () => {
  test('parses valid YES output with arbitrary basename and content', () => {
    expect(parsePrototypeOutput(validYes('state-machine.md', 'state spec'))).toEqual({
      ok: true,
      decision: 'created',
      artifactName: 'state-machine.md',
      requestedFilename: 'state-machine.md',
      reason: 'clarify the interaction before implementation',
      content: 'state spec',
    })
  })

  test('parses valid NO output', () => {
    expect(
      parsePrototypeOutput(
        [
          'PROTOTYPE: NO',
          'ARTIFACT: none',
          'REASON: library upgrade risk is already concrete',
        ].join('\n')
      )
    ).toEqual({
      ok: true,
      decision: 'skipped',
      requestedFilename: null,
      reason: 'library upgrade risk is already concrete',
    })
  })

  test('falls back for missing markers and malformed YES output', () => {
    expect(parsePrototypeOutput('no markers')).toMatchObject({
      ok: false,
      reason: 'missing required prototype markers',
    })
    expect(parsePrototypeOutput('PROTOTYPE: YES\nARTIFACT: sketch.html\nREASON: useful')).toEqual({
      ok: false,
      requestedFilename: 'sketch.html',
      reason: 'missing prototype artifact content',
    })
  })

  test('falls back for unsafe names', () => {
    for (const name of ['../x.html', 'nested/x.html', '/tmp/x.html', 'C:\\x.html', 'bad\u0000']) {
      expect(parsePrototypeOutput(validYes(name))).toMatchObject({
        ok: false,
        reason: 'unsafe or missing prototype artifact name',
      })
    }
  })

  test('parses artifact content containing markdown horizontal rules', () => {
    const parsed = parsePrototypeOutput(
      validYes('diagram.md', ['# Flow', '', '---', '', 'done'].join('\n'))
    )

    expect(parsed).toMatchObject({ ok: true, decision: 'created' })
    expect(parsed.ok && parsed.decision === 'created' ? parsed.content : '').toContain('\n---\n')
  })
})

describe('writePrototypeOutput', () => {
  test('created prototype writes summary, manifest, and namespaced artifact', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Prototype the flow', null)

    const result = await writePrototypeOutput(task, validYes('flow.html', '<main>flow</main>'))

    expect(result).toMatchObject({ decision: 'created' })
    expect(await Bun.file(`${task.dir}/prototype-artifacts/flow.html`).text()).toBe(
      '<main>flow</main>'
    )
    expect(await Bun.file(`${task.dir}/prototype.md`).text()).toContain(
      'Primary artifact: prototype-artifacts/flow.html'
    )
    expect(await readPrototypeManifest(task)).toEqual({
      decision: 'created',
      primaryArtifact: 'prototype-artifacts/flow.html',
      requestedFilename: 'flow.html',
      reason: 'clarify the interaction before implementation',
    })
  })

  test('skipped prototype writes concise decision artifact', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Upgrade dependency', null)

    await writePrototypeOutput(
      task,
      ['PROTOTYPE: NO', 'ARTIFACT: none', 'REASON: no standalone artifact would derisk it'].join(
        '\n'
      )
    )

    expect(await Bun.file(`${task.dir}/prototype.md`).text()).toContain('Decision: skipped')
    expect(await readPrototypeManifest(task)).toMatchObject({
      decision: 'skipped',
      primaryArtifact: null,
      reason: 'no standalone artifact would derisk it',
    })
  })

  test('malformed output writes raw prototype.md and never writes unsafe filenames', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Unsafe prototype', null)
    const raw = validYes('../x.html', 'bad')

    await writePrototypeOutput(task, raw)

    expect(await Bun.file(`${task.dir}/prototype.md`).text()).toBe(raw)
    expect(await Bun.file(`${task.dir}/prototype-artifacts/../x.html`).exists()).toBe(false)
    expect(await prototypePrimaryArtifactPath(task)).toBeNull()
    expect(await readPrototypeManifest(task)).toMatchObject({
      decision: 'fallback',
      primaryArtifact: null,
      requestedFilename: '../x.html',
    })
  })

  test('prototype context includes decision, reason, artifact path, and clipped content', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Context', null)
    await writePrototypeOutput(task, validYes('flow.html', 'x'.repeat(50)))

    const context = await prototypeContext(task, { artifactLimit: 10 })

    expect(context).toContain('Decision: created')
    expect(context).toContain('Reason: clarify the interaction before implementation')
    expect(context).toContain('Primary artifact: prototype-artifacts/flow.html')
    expect(context).toContain('xxxxxxxxxx\n[truncated after 10 chars]')
  })
})
