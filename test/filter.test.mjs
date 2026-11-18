import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.mjs'
import { scoreTask, filterTasks, bountyOf, taskKey, summarize } from '../src/filter.mjs'

const config = loadConfig({
  MOLTASK_WALLET: '0x64AD4f5CdFc4b14A3dceBF091a0f4e4A58C4eee3',
  MOLTASK_CATEGORIES: 'coding,research',
  MOLTASK_MIN_BOUNTY: '100',
})

const task = overrides => ({
  id: 'api-id-1',
  on_chain_task_id: '0xabc123',
  title: 'Build a small CLI tool',
  description: 'Write a working Node.js CLI with tests and a README. ' + 'x'.repeat(220),
  category: 'coding',
  bounty_amount: '7500',
  requirements: ['Working code', 'README'],
  deliverables: ['GitHub repository'],
  ...overrides,
})

test('a well-formed coding ask in an allowed category is suitable', () => {
  const verdict = scoreTask(task(), config)
  assert.equal(verdict.suitable, true)
  assert.equal(verdict.key, '0xabc123')
  assert.equal(verdict.bounty, 7500)
  assert.deepEqual(verdict.reasons, [])
  assert.ok(verdict.score > 0)
})

test('taskKey prefers the on-chain id, then the API id, then the hash', () => {
  assert.equal(taskKey({ on_chain_task_id: '0x1', id: 'a', task_hash: '0xh' }), '0x1')
  assert.equal(taskKey({ id: 'a', task_hash: '0xh' }), 'a')
  assert.equal(taskKey({ task_hash: '0xh' }), '0xh')
  assert.equal(taskKey({}), '')
})

test('bountyOf tolerates strings, numbers and junk', () => {
  assert.equal(bountyOf({ bounty_amount: '7500' }), 7500)
  assert.equal(bountyOf({ bounty_amount: 3000 }), 3000)
  assert.equal(bountyOf({ bounty_amount: '' }), 0)
  assert.equal(bountyOf({}), 0)
})

test('a category outside the allowlist is rejected with a reason', () => {
  const verdict = scoreTask(task({ category: 'design' }), config)
  assert.equal(verdict.suitable, false)
  assert.ok(verdict.reasons.some(r => /outside the allowlist/.test(r)))
})

test('asks below the bounty floor are rejected', () => {
  const verdict = scoreTask(task({ bounty_amount: '50' }), config)
  assert.equal(verdict.suitable, false)
  assert.ok(verdict.reasons.some(r => /below the 100 MOLT floor/.test(r)))
})

test('a ceiling rejects otherwise-good asks', () => {
  const capped = loadConfig({ MOLTASK_CATEGORIES: 'coding', MOLTASK_MAX_BOUNTY: '5000' })
  const verdict = scoreTask(task(), capped)
  assert.equal(verdict.suitable, false)
  assert.ok(verdict.reasons.some(r => /above the 5000 MOLT ceiling/.test(r)))
})

test('required keywords must appear in the text', () => {
  const keyworded = loadConfig({ MOLTASK_CATEGORIES: 'coding', MOLTASK_KEYWORDS: 'bot' })
  assert.equal(scoreTask(task(), keyworded).suitable, false)
  const matching = scoreTask(task({ title: 'Build a task bot' }), keyworded)
  assert.equal(matching.suitable, true)
})

test('excluded keywords veto an ask', () => {
  const excluded = loadConfig({ MOLTASK_CATEGORIES: 'coding', MOLTASK_EXCLUDE: 'video' })
  const verdict = scoreTask(task({ description: 'Record a short video demo' }), excluded)
  assert.equal(verdict.suitable, false)
  assert.ok(verdict.reasons.some(r => /excluded keyword "video"/.test(r)))
})

test('metadata-only rows (no bounty, no id) are rejected', () => {
  const verdict = scoreTask({ title: 'Ghost task', category: 'coding', bounty_amount: '' }, config)
  assert.equal(verdict.suitable, false)
  assert.ok(verdict.reasons.some(r => /bounty is missing/.test(r)))
  assert.ok(verdict.reasons.some(r => /no id/.test(r)))
})

test('filterTasks drops unsuitable asks and ranks the rest by score', () => {
  const tasks = [
    task({ id: 'low', on_chain_task_id: '0xlow', bounty_amount: '200' }),
    task({ id: 'high', on_chain_task_id: '0xhigh', bounty_amount: '9000' }),
    task({ id: 'design', on_chain_task_id: '0xdesign', category: 'design', bounty_amount: '9000' }),
  ]
  const ranked = filterTasks(tasks, config)
  assert.deepEqual(ranked.map(entry => entry.task.id), ['high', 'low'])
})

test('summarize produces the one-line queue label', () => {
  const verdict = scoreTask(task(), config)
  assert.match(summarize(verdict), /^\d+ MOLT · score [\d.]+$/)
})
