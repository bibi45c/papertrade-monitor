// Only public, read-only queries use this helper, including JSON-RPC POSTs.
export class ReadError extends Error {
  constructor(message, retryable = false, delayMs = 0) {
    super(message); this.name = 'ReadError'; this.retryable = retryable; this.delayMs = delayMs;
  }
}

export function checkRpcError(reply) {
  if (!reply?.error) return;
  const { code, message } = reply.error;
  // 负载均衡后的节点同步有先后：刚取到的最新区块在另一节点上可能还不存在，稍后重试即可。
  const lagging = /invalid block height|header not found|unknown block|block not found/i.test(message ?? '');
  const permanent = !lagging && ([-32600, -32601, -32602].includes(code) || /revert|invalid|unsupported|unauthori[sz]ed|forbidden/i.test(message ?? ''));
  const transient = lagging || code === -32005 || code === -32603 || /temporar|unavailable|timeout|timed out|rate|busy|try again|internal/i.test(message ?? '');
  throw new ReadError('RPC: ' + String(message ?? code).slice(0, 140), !permanent && transient);
}

export async function retryRead(operation, { attempts = 3, budgetMs = 10000, timeoutMs = 3000, deadline = Date.now() + budgetMs,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = Date.now, random = Math.random } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remaining = deadline - clock();
    if (remaining <= 0) break;
    try { return await operation(AbortSignal.timeout(Math.max(1, Math.floor(Math.min(timeoutMs, remaining))))); }
    catch (error) {
      last = error;
      if (!error.retryable || attempt + 1 === attempts) throw error;
      const delay = Math.max(error.delayMs ?? 0, 250 * 2 ** attempt + Math.floor(random() * 100));
      if (delay >= deadline - clock()) throw error;
      await wait(delay);
    }
  }
  throw last ?? new ReadError('Read retry time budget exceeded');
}

export async function readJson(url, body, fetcher = fetch, { validate = value => value, ...options } = {}) {
  return retryRead(async signal => {
    let response;
    try {
      response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    } catch (error) { throw new ReadError('Network read failed: ' + String(error.message ?? error).slice(0, 120), true); }
    if (!response.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
      const header = response.headers?.get('Retry-After');
      const delay = header === null || header === undefined ? 0 : /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now());
      throw new ReadError(`HTTP ${response.status}`, retryable, Number.isFinite(delay) ? delay : 0);
    }
    let value;
    try { value = await response.json(); }
    catch (error) { throw new ReadError('Invalid JSON response', error.name !== 'SyntaxError'); }
    return validate(value);
  }, options);
}
