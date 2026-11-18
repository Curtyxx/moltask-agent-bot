import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { emptyState } from '../src/state.mjs'
import { runOnce, watch, workOrderMarkdown } from '../src/bot.mjs'

const WALLET = '0x64AD4f5CdFc4b14A3dceBF091a0f4e4A58C4eee3'

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'moltask-bot-'))
  return loadConfig({
    MOLTASK_WALLET: WALLET,
    MOLTASK_CATEGORIES: 'coding,automation',
    MOLTASK_MIN_BOUNTY: '100',
    MOLTASK_STATE_FILE: join(dir, 'state.json'),
    MOLTASK_WORK_ORDER_DIR: join(dir, 'orders'),
  })
}

const goodTask = (id = '0xgood') => ({
  id: `api-${id}`,
  on_chain_task_id: id,
  title: 'Build an automation bot',
  description: 'Working code, tests, README and a demo. ' + 'y'.repeat(200),
  category: 'automation',
  bounty_amount: '7500',
  requirements: ['Working code'],
  deliverables: ['Repository'],
})

const badTask = () => ({ id: 'api-bad', on_chain_task_id: '0xbad', title: 'Design a logo', category: 'design', bounty_amount: '9000' })

function fakeApi(tasks) {
  let served = 0
  return {
    get served() { return served },
    async listTasks() {
      served++
      return { success: true, tasks, total: tasks.length }
    },
  }
}

test('runOnce queues only suitable asks and writes one work order each', async () => {
  const config = tempConfig()
  const state = emptyState(config.wallet)
  const log = []
  const result = await runOnce({ api: fakeApi([goodTask(), badTask()]), config, state, log: line => log.push(line) })

  assert.equal(result.fetched, 2)
  assert.equal(result.suitable, 1)
  assert.equal(result.added, 1)
  assert.equal(result.skipped, 1)
  assert.equal(state.queue.length, 1)
  assert.ok(existsSync(config.stateFile), 'state file must be written')
  const orders = readdirSync(config.workOrderDir)
  assert.equal(orders.length, 1)
  assert.match(readFileSync(join(config.workOrderDir, orders[0]), 'utf8'), /Build an automation bot/)
  assert.ok(log.some(line => line.includes('queued 7500 MOLT')))
})

test('a second cycle does not re-queue what it already saw', async () => {
  const config = tempConfig()
  const state = emptyState(config.wallet)
  const api = fakeApi([goodTask()])
  await runOnce({ api, config, state })
  const second = await runOnce({ api, config, state })
  assert.equal(second.added, 0)
  assert.equal(second.suitable, 1)
  assert.equal(state.queue.length, 1)
  assert.equal(api.served, 2)
})

test('persist: false leaves the state file untouched (the demo command relies on it)', async () => {
  const config = tempConfig()
  const state = emptyState(config.wallet)
  await runOnce({ api: fakeApi([goodTask()]), config, state, persist: false })
  assert.equal(existsSync(config.stateFile), false)
  assert.equal(state.queue.length, 1)
})

test('a failing cycle is logged and does not kill watch', async () => {
  const config = tempConfig()
  const state = emptyState(config.wallet)
  let attempt = 0
  const flaky = {
    async listTasks() {
      attempt++
      if (attempt === 1) throw new Error('network down')
      return { success: true, tasks: [goodTask()] }
    },
  }
  const log = []
  const result = await watch({ api: flaky, config, state, maxCycles: 2, log: line => log.push(line), sleepImpl: async () => true })
  assert.equal(result.cycles, 2)
  assert.equal(result.failures, 1)
  assert.equal(state.queue.length, 1)
  assert.ok(log.some(line => /cycle 1 failed: network down/.test(line)))
})

test('workOrderMarkdown carries the payout, ids and the submit command', () => {
  const config = tempConfig()
  const task = goodTask()
  const markdown = workOrderMarkdown(task, { key: '0xgood', bounty: 7500, score: 8.5 }, config)
  assert.match(markdown, /Payout:\*\* 7500 MOLT/)
  assert.match(markdown, /0xgood/)
  assert.match(markdown, /## Requirements/)
  assert.match(markdown, /## Deliverables/)
  assert.match(markdown, /submit 0xgood --message-file work\.md/)
  assert.match(markdown, new RegExp(WALLET))
})
