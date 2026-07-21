import { describe, expect, test } from 'bun:test'
import {
  decompositionChainId,
  parseDecomposition,
  renderDecomposition,
  stagedUnitIntent,
} from '../src/decomposition.ts'

const valid = {
  summary: 'Schema before producer.',
  units: [
    { name: 'schema', intent: 'Add the additive schema.', verify: 'bun test schema' },
    { name: 'producer', intent: 'Enable the producer.', verify: null },
  ],
}
const producer = { name: 'producer', intent: 'Enable the producer.', verify: null }

describe('staged decomposition', () => {
  test('validates raw and fenced JSON at the agent boundary', () => {
    expect(parseDecomposition(JSON.stringify(valid))).toEqual(valid)
    expect(parseDecomposition(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toEqual(valid)
  })

  test('rejects malformed, duplicate, and single-unit output', () => {
    expect(parseDecomposition('not json')).toBeNull()
    expect(parseDecomposition(JSON.stringify({ ...valid, units: [valid.units[0]] }))).toBeNull()
    expect(
      parseDecomposition(
        JSON.stringify({ ...valid, units: [valid.units[0], { ...valid.units[1], name: 'SCHEMA' }] })
      )
    ).toBeNull()
  })

  test('uses a stable plan-scoped chain id', () => {
    expect(decompositionChainId('parent', 'same plan')).toBe(
      decompositionChainId('parent', 'same plan')
    )
    expect(decompositionChainId('parent', 'same plan')).not.toBe(
      decompositionChainId('parent', 'different plan')
    )
  })

  test('renders an auditable manifest and self-contained child intent', () => {
    const manifest = renderDecomposition(valid, 'parent-12345678')
    expect(manifest).toContain('## 1. schema')
    expect(manifest).toContain('## 2. producer')
    const intent = stagedUnitIntent({
      parentTaskId: 'parent',
      sourceWorktree: '/repo/source',
      chainId: 'parent-12345678',
      unit: producer,
      index: 1,
      count: 2,
    })
    expect(intent).toContain('Staged delivery unit 2 of 2')
    expect(intent).toContain('Factory dispatches this chain serially')
    expect(intent).toContain('/repo/source')
    expect(intent).toContain('Enable the producer.')
  })
})
