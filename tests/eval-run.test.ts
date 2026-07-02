import { describe, expect, test } from 'bun:test'
import { diffFileSet, EvalCaseSchema, fileJaccard } from '../src/eval-run.ts'

describe('eval replay scoring', () => {
  test('diffFileSet extracts touched files from unified and no-index diffs', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/dev/null b/src/new.ts',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+created',
    ].join('\n')
    expect([...diffFileSet(diff)].sort()).toEqual(['src/a.ts', 'src/new.ts'])
  })

  test('fileJaccard measures overlap with sane edge cases', () => {
    const a = new Set(['x.ts', 'y.ts'])
    const b = new Set(['y.ts', 'z.ts'])
    expect(fileJaccard(a, b)).toBeCloseTo(1 / 3)
    expect(fileJaccard(a, a)).toBe(1)
    expect(fileJaccard(new Set(), new Set())).toBe(1)
    expect(fileJaccard(a, new Set())).toBe(0)
  })

  test('accepts real captured case shapes', () => {
    const parsed = EvalCaseSchema.safeParse({
      id: 'add-snmp-telemetry',
      ts: '2026-06-25T00:00:00.000Z',
      outcome: 'done',
      reason: null,
      worktree: '/data/repos/yc-code',
      baseCommit: 'abc123^',
      verify: 'yc rspec spec/foo_spec.rb',
      spec: 'Add SNMP telemetry',
      diff: 'diff --git a/x b/x',
    })
    expect(parsed.success).toBe(true)
  })
})
