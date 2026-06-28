import { describe, expect, test } from 'bun:test'
import { parseWorkforcePlan, serializeWorkforcePlan } from '../src/workforce.ts'

describe('workforce plan parsing', () => {
  test('parses fenced JSON and drops duplicate scout/lens kinds', () => {
    const parsed = parseWorkforcePlan(`\`\`\`json
{
  "research": [
    { "kind": "code", "agent": "implementer", "policies": ["ts"], "reason": "map code" },
    { "kind": "code", "agent": "reviewer", "policies": [], "reason": "duplicate" }
  ],
  "review": [
    { "kind": "correctness", "agent": "reviewer", "policies": [], "reason": "required" },
    { "kind": "deploy", "agent": "reviewer.deploy", "policies": ["deploy"], "reason": "rollout" },
    { "kind": "deploy", "agent": "reviewer", "policies": [], "reason": "duplicate" }
  ]
}
\`\`\``)

    expect(parsed).toEqual({
      research: [{ kind: 'code', agent: 'implementer', policies: ['ts'], reason: 'map code' }],
      review: [
        { kind: 'correctness', agent: 'reviewer', policies: [], reason: 'required' },
        {
          kind: 'deploy',
          agent: 'reviewer.deploy',
          policies: ['deploy'],
          reason: 'rollout',
        },
      ],
    })
  })

  test('rejects unknown scout and review kinds', () => {
    expect(
      parseWorkforcePlan(
        serializeWorkforcePlan({
          research: [{ kind: 'code', agent: 'implementer', policies: [], reason: '' }],
          review: [{ kind: 'correctness', agent: 'reviewer', policies: [], reason: '' }],
        }).replace('"code"', '"invented"')
      )
    ).toBeNull()
  })
})
