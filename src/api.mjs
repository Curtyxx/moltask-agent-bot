/**
 * MolTask REST client. No API key exists on this platform: the wallet address in
 * the request body is the identity, so the client validates it and never retries
 * a write (a double submit is a double claim on someone else's bounty).
 */

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export class MoltaskApiError extends Error {
  constructor(message, { status = 0, code = null, body = null, path = '' } = {}) {
    super(message)
    this.name = 'MoltaskApiError'
    this.status = status
    this.code = code
    this.body = body
    this.path = path
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export class MoltaskApi {
  /**
   * @param {{baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number, retries?: number, sleepImpl?: (ms: number) => Promise<void>}} [options]
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://www.moltask.com/api').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 15000
    this.retries = options.retries ?? 2
    this.sleep = options.sleepImpl ?? sleep
    /** Every request path this instance has seen, for `doctor` and tests. */
    this.calls = []
  }

  /**
   * @param {string} path e.g. `/tasks`
   * @param {{method?: string, query?: Record<string, unknown>, body?: unknown, retries?: number}} [options]
   */
  async request(path, options = {}) {
    const { method = 'GET', query, body } = options
    const idempotent = method === 'GET'
    const attempts = idempotent ? (options.retries ?? this.retries) : 0
    const url = this.#url(path, query)
    this.calls.push(`${method} ${path}`)

    let lastError
    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(1000 * 2 ** (attempt - 1), 8000))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        })
        const text = await response.text()
        const parsed = text === '' ? null : safeJson(text)
        if (!response.ok) {
          const error = new MoltaskApiError(
            `${method} ${path} failed: ${response.status} ${describe(parsed) ?? response.statusText}`,
            { status: response.status, code: parsed?.code ?? null, body: parsed, path },
          )
          if (idempotent && RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
            lastError = error
            continue
          }
          throw error
        }
        return parsed
      } catch (error) {
        if (error instanceof MoltaskApiError) {
          if (RETRYABLE_STATUS.has(error.status) && idempotent && attempt < attempts) {
            lastError = error
            continue
          }
          throw error
        }
        lastError = new MoltaskApiError(`${method} ${path} failed: ${error.message}`, { path })
        if (!idempotent || attempt === attempts) throw lastError
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError
  }

  /** Platform guide, stats and contract addresses. */
  onboard() {
    return this.request('/onboard')
  }

  /**
   * @param {{status?: string, category?: string, limit?: number, offset?: number}} [options]
   * @returns {Promise<{success: boolean, tasks: object[], total: number, limit?: number, offset?: number}>}
   */
  listTasks(options = {}) {
    const query = {}
    if (options.status !== undefined) query.status = options.status
    if (options.category) query.category = options.category
    if (options.limit !== undefined) query.limit = options.limit
    if (options.offset !== undefined) query.offset = options.offset
    return this.request('/tasks', { query })
  }

  /** @param {string} id */
  getTask(id) {
    return this.request(`/tasks/${encodeURIComponent(id)}`)
  }

  /** @param {string} id */
  getSubmissions(id) {
    return this.request(`/tasks/${encodeURIComponent(id)}/submissions`)
  }

  /**
   * Submit completed work. The route takes either the API id or the on-chain id.
   * @param {string} taskId
   * @param {{workerAddress: string, message: string, linkUrl?: string, linkType?: string}} submission
   */
  async submitWork(taskId, submission) {
    const { workerAddress, message, linkUrl, linkType } = submission
    if (!WALLET_RE.test(workerAddress ?? '')) throw new MoltaskApiError('workerAddress must be a 0x-prefixed 40-hex address')
    if (typeof message !== 'string' || message.trim().length < 20) {
      throw new MoltaskApiError('message must describe the delivered work (at least 20 characters)')
    }
    const body = { worker_address: workerAddress, message: message.trim() }
    if (linkUrl) {
      body.link_url = linkUrl
      body.link_type = linkType ?? 'other'
    }
    return this.request(`/tasks/${encodeURIComponent(taskId)}/submit`, { method: 'POST', body })
  }

  /** @param {string} address */
  getProfile(address) {
    if (!WALLET_RE.test(address ?? '')) throw new MoltaskApiError('address must be a 0x-prefixed 40-hex address')
    return this.request('/profile', { query: { address } })
  }

  /** @param {{address: string, skills?: string[], categories?: string[], displayName?: string, bio?: string}} profile */
  updateProfile(profile) {
    if (!WALLET_RE.test(profile.address ?? '')) throw new MoltaskApiError('address must be a 0x-prefixed 40-hex address')
    const body = { address: profile.address }
    if (profile.skills) body.skills = profile.skills
    if (profile.categories) body.categories = profile.categories
    if (profile.displayName) body.display_name = profile.displayName
    if (profile.bio) body.bio = profile.bio
    return this.request('/profile', { method: 'POST', body })
  }

  gasStationStatus() {
    return this.request('/gas-station')
  }

  /** @param {string} address */
  requestGas(address) {
    if (!WALLET_RE.test(address ?? '')) throw new MoltaskApiError('address must be a 0x-prefixed 40-hex address')
    return this.request('/gas-station', { method: 'POST', body: { address } })
  }

  #url(path, query) {
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    return url.toString()
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 500) }
  }
}

function describe(body) {
  if (!body) return null
  if (typeof body === 'string') return body
  return body.error ?? body.message ?? null
}
