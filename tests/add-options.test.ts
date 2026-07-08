import { describe, expect, test } from 'bun:test'
import { parseAddOptions } from '../src/add-options.ts'

function expectParsed(args: string[]) {
  const parsed = parseAddOptions(args)
  if (!parsed.ok) {
    throw new Error(parsed.message)
  }
  return parsed.options
}

function expectError(args: string[]): string {
  const parsed = parseAddOptions(args)
  if (parsed.ok) {
    throw new Error('expected parse failure')
  }
  return parsed.message
}

describe('parseAddOptions', () => {
  test('parses --trivial', () => {
    expect(expectParsed(['--trivial', 'Fix', 'typo'])).toEqual({
      args: ['Fix', 'typo'],
      raw: false,
      complexity: 'trivial',
      allowDirty: false,
      name: null,
    })
  })

  test('parses --complexity trivial like --trivial', () => {
    expect(expectParsed(['--complexity', 'trivial', 'Fix', 'typo'])).toEqual({
      args: ['Fix', 'typo'],
      raw: false,
      complexity: 'trivial',
      allowDirty: false,
      name: null,
    })
  })

  test('parses --complexity complex', () => {
    expect(expectParsed(['--complexity', 'complex', 'Refactor', 'parser'])).toEqual({
      args: ['Refactor', 'parser'],
      raw: false,
      complexity: 'complex',
      allowDirty: false,
      name: null,
    })
  })

  test('accepts redundant trivial declarations', () => {
    expect(expectParsed(['--trivial', '--complexity', 'trivial', 'Fix', 'typo'])).toEqual({
      args: ['Fix', 'typo'],
      raw: false,
      complexity: 'trivial',
      allowDirty: false,
      name: null,
    })
  })

  test('rejects conflicting complexity declarations', () => {
    expect(expectError(['--trivial', '--complexity', 'complex', 'Fix', 'typo'])).toContain(
      'conflicting complexity flags'
    )
  })

  test('rejects missing --complexity value', () => {
    expect(expectError(['--complexity'])).toContain(
      '--complexity needs a value: trivial or complex'
    )
  })

  test('rejects invalid --complexity value', () => {
    expect(expectError(['--complexity', 'maybe'])).toContain(
      'invalid complexity "maybe" (expected trivial or complex)'
    )
  })

  test('parses complexity flags before --verify and removes them from intent args', () => {
    expect(
      expectParsed(['--complexity', 'trivial', 'Fix', 'typo', '--verify', 'bun', 'test'])
    ).toEqual({
      args: ['Fix', 'typo', '--verify', 'bun', 'test'],
      raw: false,
      complexity: 'trivial',
      allowDirty: false,
      name: null,
    })
  })

  test('rejects complexity flags after --verify', () => {
    expect(expectError(['Fix', 'typo', '--verify', 'bun', 'test', '--trivial'])).toContain(
      'complexity flags must appear before --verify'
    )
    expect(expectError(['Fix', 'typo', '--verify', 'bun', 'test', '--complexity'])).toContain(
      'complexity flags must appear before --verify'
    )
  })

  test('preserves normal verify tokens after --verify', () => {
    expect(expectParsed(['Fix', 'typo', '--verify', 'bun', 'test', '--raw'])).toEqual({
      args: ['Fix', 'typo', '--verify', 'bun', 'test', '--raw'],
      raw: false,
      complexity: null,
      allowDirty: false,
      name: null,
    })
  })

  test('parses --raw before --verify', () => {
    expect(expectParsed(['--raw', 'Fix', 'typo'])).toEqual({
      args: ['Fix', 'typo'],
      raw: true,
      complexity: null,
      allowDirty: false,
      name: null,
    })
  })
})

describe('parseAddOptions --allow-dirty', () => {
  test('parses --allow-dirty and strips it from intent args', () => {
    expect(expectParsed(['--allow-dirty', 'New', 'task'])).toEqual({
      args: ['New', 'task'],
      raw: false,
      complexity: null,
      allowDirty: true,
      name: null,
    })
  })
})

describe('parseAddOptions --name', () => {
  test('parses --name and strips it from intent args', () => {
    expect(expectParsed(['--name', 'fix-upload', 'Fix', 'the', 'upload'])).toEqual({
      args: ['Fix', 'the', 'upload'],
      raw: false,
      complexity: null,
      allowDirty: false,
      name: 'fix-upload',
    })
  })

  test('rejects --name without a value', () => {
    expect(expectError(['--name'])).toContain('--name needs a value')
  })
})
