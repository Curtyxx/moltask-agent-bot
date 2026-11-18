import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, hasWallet, DEFAULTS } from '../src/config.mjs'

const WALLET = '0x64AD4f5CdFc4b14A3dceBF091a0f4e4A58C4eee3'

test('defaults are safe: no wallet, no auto-submit, sane interval', () => {
  const config = loadConfig({})
  assert.equal(config.wallet, '')
  assert.equal(config.autoSubmit, false)
  assert.equal(config.pollSeconds, DEFAULTS.pollSeconds)
  assert.equal(hasWallet(config), false)
})

test('reads wallet, categories and filters from the environment', () => {
  const config = loadConfig({
    MOLTASK_WALLET: WALLET,
    MOLTASK_CATEGORIES: 'coding, research ,',
    MOLTASK_KEYWORDS: 'bot,api',
    MOLTASK_EXCLUDE: 'video',
    MOLTASK_MIN_BOUNTY: '100',
    MOLTASK_MAX_BOUNTY: '9000',
  })
  assert.equal(config.wallet, WALLET)
  assert.equal(hasWallet(config), true)
  assert.deepEqual(config.categories, ['coding', 'research'])
  assert.deepEqual(config.keywords, ['bot', 'api'])
  assert.deepEqual(config.excludeKeywords, ['video'])
  assert.equal(config.minBounty, 100)
  assert.equal(config.maxBounty, 9000)
})

test('the config file is merged, and environment wins over it', () => {
  const readFile = () => JSON.stringify({ wallet: WALLET, categories: ['writing'], minBounty: 50 })
  const fromFile = loadConfig({}, { filePath: 'x.json', readFile })
  assert.equal(fromFile.wallet, WALLET)
  assert.deepEqual(fromFile.categories, ['writing'])
  assert.equal(fromFile.minBounty, 50)

  const fromEnv = loadConfig({ MOLTASK_MIN_BOUNTY: '500' }, { filePath: 'x.json', readFile })
  assert.equal(fromEnv.minBounty, 500)
})

test('a broken config file warns instead of throwing', () => {
  const config = loadConfig({ MOLTASK_WALLET: '0x64AD4f5CdFc4b14A3dceBF091a0f4e4A58C4eee3' }, { filePath: 'bad.json', readFile: () => '{not json' })
  assert.ok(config.warnings.some(w => /config file bad\.json ignored/.test(w)))
  assert.equal(config.warnings.length, 1)
})

test('a missing config file is silent, not a warning', () => {
  const readFile = () => { throw Object.assign(new Error('no such file: x.json'), { code: 'ENOENT' }) }
  const config = loadConfig({ MOLTASK_WALLET: WALLET }, { filePath: 'x.json', readFile })
  assert.equal(config.wallet, WALLET)
  assert.equal(config.warnings.length, 0)
})

test('poll interval below 5s is lifted to the floor', () => {
  const config = loadConfig({ MOLTASK_POLL_SECONDS: '1' })
  assert.equal(config.pollSeconds, 5)
  assert.ok(config.warnings.some(w => /below the 5s floor/.test(w)))
})

test('an invalid wallet warns but does not abort discovery', () => {
  for (const wallet of ['', '0x123', 'not-a-wallet', `${WALLET}00`]) {
    const config = loadConfig({ MOLTASK_WALLET: wallet })
    assert.equal(hasWallet(config), false)
    assert.ok(config.warnings.some(w => /wallet is missing or not/.test(w)))
  }
})

test('apiBase loses trailing slashes so paths concatenate cleanly', () => {
  assert.equal(loadConfig({ MOLTASK_API_BASE: 'https://example.test/api///' }).apiBase, 'https://example.test/api')
})
