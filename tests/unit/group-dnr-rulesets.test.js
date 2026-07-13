/**
 * Ghostery Browser Extension
 * https://www.ghostery.com/
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { groupRulesetFile } from '../../scripts/utils/group-dnr-rulesets.js'

test('groupRulesetFile chunks requestDomains to at most 1000 per rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghostery-dnr-group-'))
  const rulesetPath = join(dir, 'dnr-test.json')

  const rules = []
  for (let i = 0; i < 2500; i += 1) {
    rules.push({
      id: i + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: `||tracker-${i}.example^` }
    })
  }

  writeFileSync(rulesetPath, JSON.stringify(rules))

  const { before, after } = groupRulesetFile(rulesetPath)
  assert.equal(before, 2500)
  assert.equal(after, 3)

  const grouped = JSON.parse(readFileSync(rulesetPath, 'utf8'))
  const domainRules = grouped.filter((r) => r.condition?.requestDomains)

  assert.equal(domainRules.length, 3)
  for (const rule of domainRules) {
    assert.ok(rule.condition.requestDomains.length <= 1000)
  }

  const totalDomains = domainRules.reduce(
    (n, r) => n + r.condition.requestDomains.length,
    0
  )
  assert.equal(totalDomains, 2500)
})
