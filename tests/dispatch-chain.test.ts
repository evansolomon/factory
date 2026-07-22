import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  createDispatchChain,
  readDispatchChain,
  updateDispatchChain,
} from '../src/dispatch-chain.ts'

describe('dispatch chain state', () => {
  test('persists the foreground supervisor handoff and terminal outcome', async () => {
    const repoStateDir = await mkdtemp(`${tmpdir()}/factory-chain-`)
    await createDispatchChain(repoStateDir, {
      id: 'parent-abcd1234',
      parentTaskId: 'parent',
      units: ['one', 'two'],
    })

    await updateDispatchChain(repoStateDir, 'parent-abcd1234', {
      currentUnit: 'one',
      status: 'running',
    })
    expect(await readDispatchChain(repoStateDir, 'parent-abcd1234')).toMatchObject({
      currentUnit: 'one',
      status: 'running',
      units: ['one', 'two'],
    })

    await updateDispatchChain(repoStateDir, 'parent-abcd1234', {
      currentUnit: 'two',
      status: 'done',
    })
    expect(await readDispatchChain(repoStateDir, 'parent-abcd1234')).toMatchObject({
      currentUnit: 'two',
      status: 'done',
    })
  })

  test('missing and malformed records fail closed to unknown', async () => {
    const repoStateDir = await mkdtemp(`${tmpdir()}/factory-chain-`)
    expect(await readDispatchChain(repoStateDir, 'missing')).toBeNull()
    await mkdir(`${repoStateDir}/chains`)
    await Bun.write(`${repoStateDir}/chains/bad.json`, '{')
    expect(await readDispatchChain(repoStateDir, 'bad')).toBeNull()
  })
})
