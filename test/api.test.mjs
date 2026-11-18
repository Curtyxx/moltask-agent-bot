import test from 'node:test'
import assert from 'node:assert/strict'
import { MoltaskApi, MoltaskApiError } from '../src/api.mjs'

const WALLET = '0x64AD4f5CdFc4b14A3dceBF091a0f4e4A58C4eee3'

/** Minimal fetch double: records calls, replies from a queue of responses. */
function fakeFetch(responses) {
  const calls = []
  const queue = [...responses]
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    const next = queue.shift() ?? { status: 200, body: {} }
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  impl.calls = calls
  return impl
}

const api = fetchImpl => new MoltaskApi({ baseUrl: 'https://example.test/api', fetchImpl, sleepImpl: async () => {} })

test('listTasks builds a status/category/limit query', async () => {
  const fetchImpl = fakeFetch([{ body: { success: true, tasks: [], total: 0 } }])
  const client = api(fetchImpl)
  await client.listTasks({ status: 'open', category: 'coding', limit: 5, offset: 10 })
  const url = new URL(fetchImpl.calls[0].url)
  assert.equal(url.pathname, '/api/tasks')
  assert.equal(url.searchParams.get('status'), 'open')
  assert.equal(url.searchParams.get('category'), 'coding')
  assert.equal(url.searchParams.get('limit'), '5')
  assert.equal(url.searchParams.get('offset'), '10')
})

test('GET retries a 500 and returns the eventual success', async () => {
  const fetchImpl = fakeFetch([{ status: 500, body: { error: 'boom' } }, { body: { success: true, tasks: [{ id: '1' }] } }])
  const client = new MoltaskApi({ baseUrl: 'https://example.test/api', fetchImpl, retries: 2, sleepImpl: async () => {} })
  const result = await client.listTasks({ status: 'open' })
  assert.equal(result.tasks.length, 1)
  assert.equal(fetchImpl.calls.length, 2)
})

test('POST is never retried: a duplicated submission would double-claim', async () => {
  const fetchImpl = fakeFetch([{ status: 500, body: { error: 'boom' } }, { body: { success: true } }])
  const client = new MoltaskApi({ baseUrl: 'https://example.test/api', fetchImpl, retries: 3, sleepImpl: async () => {} })
  await assert.rejects(
    () => client.submitWork('task-1', { workerAddress: WALLET, message: 'I built the thing and pushed it.' }),
    /500 boom/,
  )
  assert.equal(fetchImpl.calls.length, 1)
})

test('submitWork sends worker_address, message and a link when given', async () => {
  const fetchImpl = fakeFetch([{ body: { success: true, message: 'ok' } }])
  const client = api(fetchImpl)
  await client.submitWork('task-1', {
    workerAddress: WALLET,
    message: 'Completed the bot with tests and a README.',
    linkUrl: 'https://github.com/Curtyxx/moltask-agent-bot',
  })
  const call = fetchImpl.calls[0]
  assert.equal(call.method, 'POST')
  assert.equal(call.url, 'https://example.test/api/tasks/task-1/submit')
  assert.deepEqual(call.body, {
    worker_address: WALLET,
    message: 'Completed the bot with tests and a README.',
    link_url: 'https://github.com/Curtyxx/moltask-agent-bot',
    link_type: 'other',
  })
})

test('submitWork refuses a bad wallet or a too-short message before any request', async () => {
  const fetchImpl = fakeFetch([])
  const client = api(fetchImpl)
  await assert.rejects(() => client.submitWork('t', { workerAddress: '0x123', message: 'x'.repeat(40) }), MoltaskApiError)
  await assert.rejects(() => client.submitWork('t', { workerAddress: WALLET, message: 'too short' }), /at least 20 characters/)
  assert.equal(fetchImpl.calls.length, 0)
})

test('an API error keeps status and platform message', async () => {
  const fetchImpl = fakeFetch([{ status: 404, body: { error: 'Task not found' } }])
  const client = api(fetchImpl)
  await assert.rejects(
    () => client.getTask('missing'),
    error => error instanceof MoltaskApiError && error.status === 404 && /Task not found/.test(error.message),
  )
})

test('getProfile requires a valid address and passes it as a query', async () => {
  const fetchImpl = fakeFetch([{ body: { address: WALLET, profile: {} } }])
  const client = api(fetchImpl)
  assert.throws(() => client.getProfile('nope'), MoltaskApiError)
  await client.getProfile(WALLET)
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('address'), WALLET)
})

test('network failures become MoltaskApiError with the path', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET') }
  const client = new MoltaskApi({ baseUrl: 'https://example.test/api', fetchImpl, retries: 0, sleepImpl: async () => {} })
  await assert.rejects(() => client.onboard(), error => error instanceof MoltaskApiError && /ECONNRESET/.test(error.message))
})
