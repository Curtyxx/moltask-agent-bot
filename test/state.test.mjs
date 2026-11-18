import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyState, loadState, saveState, pruneSeen, enqueue, markSubmitted, recordEarning, totals, STATE_VERSION,
} from '../src/state.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'moltask-state-'))

const verdict = key => ({ key, bounty: 500, score: 1.5, suitable: true, reasons: [] })
const task = (key, title = 'A task') => ({ id: `api-${key}`, on_chain_task_id: key, title, category: 'coding' })

test('emptyState has every collection the bot reads', () => {
  const state = emptyState('0xabc')
  assert.equal(state.version, STATE_VERSION)
  assert.deepEqual(state.queue, [])
  assert.deepEqual(state.submissions, [])
  assert.deepEqual(state.earnings, [])
  assert.deepEqual(state.seen, {})
})

test('a missing state file is a normal start, not an error', () => {
  const { state, warnings } = loadState(join(tmp(), 'nope.json'))
  assert.deepEqual(warnings, [])
  assert.equal(state.queue.length, 0)
})

test('a corrupt state file warns and falls back to empty', () => {
  const dir = tmp()
  const path = join(dir, 'state.json')
  writeFileSync(path, '{broken', 'utf8')
  const { state, warnings } = loadState(path)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /is not JSON/)
  assert.equal(state.queue.length, 0)
})

test('save then load round-trips and leaves no temp file behind', () => {
  const dir = tmp()
  const path = join(dir, 'state.json')
  const state = emptyState('0xabc')
  enqueue(state, { task: task('0x1'), verdict: verdict('0x1') })
  saveState(path, state)

  const { state: loaded } = loadState(path)
  assert.equal(loaded.queue.length, 1)
  assert.equal(loaded.queue[0].key, '0x1')
  assert.deepEqual(readdirSync(dir), ['state.json'])
  assert.match(readFileSync(path, 'utf8'), /"version": 1/)
})

test('enqueue adds once and reports duplicates as not added', () => {
  const state = emptyState()
  const first = enqueue(state, { task: task('0x1'), verdict: verdict('0x1') })
  const second = enqueue(state, { task: task('0x1'), verdict: verdict('0x1') })
  assert.equal(first.added, true)
  assert.equal(second.added, false)
  assert.equal(second.reason, 'already seen')
  assert.equal(state.queue.length, 1)
  assert.equal(state.seen['0x1'].title, 'A task')
})

test('enqueue refuses a task without a stable id', () => {
  const state = emptyState()
  const result = enqueue(state, { task: { title: 'ghost' }, verdict: verdict('') })
  assert.equal(result.added, false)
  assert.match(result.reason, /no stable id/)
  assert.equal(state.queue.length, 0)
})

test('the queue is ranked by score', () => {
  const state = emptyState()
  enqueue(state, { task: task('0xlow'), verdict: { ...verdict('0xlow'), score: 1 } })
  enqueue(state, { task: task('0xhigh'), verdict: { ...verdict('0xhigh'), score: 9 } })
  assert.deepEqual(state.queue.map(item => item.key), ['0xhigh', '0xlow'])
})

test('markSubmitted records the submission and leaves the queue', () => {
  const state = emptyState()
  enqueue(state, { task: task('0x1'), verdict: verdict('0x1') })
  const submission = markSubmitted(state, { key: '0x1', taskId: 'api-0x1', linkUrl: 'https://example.test/pr', message: 'x'.repeat(200) })
  assert.equal(state.queue.length, 0)
  assert.equal(state.submissions.length, 1)
  assert.equal(submission.status, 'pending-approval')
  assert.equal(submission.messagePreview.length, 140)
})

test('earnings accumulate and totals round to 3 decimals', () => {
  const state = emptyState()
  recordEarning(state, { amount: 3000, key: '0x1' })
  recordEarning(state, { amount: 500.5, key: '0x2' })
  enqueue(state, { task: task('0x3'), verdict: verdict('0x3') })
  assert.deepEqual(totals(state), { queued: 1, submitted: 0, pending: 1, earned: 3500.5 })
})

test('pruneSeen drops only entries older than the window', () => {
  const state = emptyState()
  state.seen['old'] = { firstSeenAt: '2020-01-01T00:00:00.000Z' }
  state.seen['fresh'] = { firstSeenAt: new Date().toISOString() }
  const pruned = pruneSeen(state, { days: 30 })
  assert.equal(pruned, 1)
  assert.equal(state.seen.old, undefined)
  assert.ok(state.seen.fresh)
})

test('loadState tolerates a document missing collections', () => {
  const dir = tmp()
  const path = join(dir, 'state.json')
  writeFileSync(path, JSON.stringify({ version: 1, wallet: '0xabc' }), 'utf8')
  const { state } = loadState(path)
  assert.deepEqual(state.queue, [])
  assert.deepEqual(state.seen, {})
  assert.equal(existsSync(join(dir, 'state.json')), true)
})
