export const STREAM_URL = 'wss://stream.papertrade.xyz/connection/websocket';
const actions = new Set(['registerSessionKey', 'openPosition', 'closePositions', 'withdrawToCore', 'paperStake', 'paperUnstake', 'paperClaim', 'paperDistribute']);
const integer = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid execution queue integer');
  return value;
};
const gas = value => {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) throw new Error('Invalid execution queue gas');
  return value;
};

export function parseExecutionQueue(publication, now = Date.now()) {
  const s = publication?.snapshot, chain = s?.chain;
  if (typeof publication?.queueRevision !== 'string' || publication.queueRevision.length > 160 || s?.schemaVersion !== 1 || s.source !== 'relayer-postgres' || s.ok !== true || s.stale !== false || chain?.source !== 'state-postgres' || chain.ok !== true || chain.stale !== false) throw new Error('Execution queue unavailable or unknown schema');
  const at = integer(s.ts), blockAt = integer(chain.latestBlockTimestampMs), block = integer(chain.latestBlockNumber);
  if (now - at > 5000 || at > now + 5000 || now - blockAt > 15000 || blockAt > now + 5000) throw new Error('Execution queue publication or chain is stale');
  const blockGasLimit = gas(s.blockGasLimit), queuedGas = gas(s.totalQueuedGas), submittedGas = gas(s.totalSubmittedGas), pendingGas = gas(s.totalPendingGas);
  if (BigInt(blockGasLimit) <= 0n || BigInt(pendingGas) !== BigInt(queuedGas) + BigInt(submittedGas)) throw new Error('Inconsistent execution queue gas');
  const blocks = (BigInt(pendingGas) + BigInt(blockGasLimit) - 1n) / BigInt(blockGasLimit);
  if (blocks > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isFinite(s.saturationPct) || s.saturationPct < 0) throw new Error('Invalid execution queue capacity');
  if (!Array.isArray(chain.blocks) || chain.blocks.at(-1)?.number !== block) throw new Error('Inconsistent execution queue latest block');
  const hasPreview = s.queuePreview !== undefined;
  if (hasPreview && (!Array.isArray(s.queuePreview) || s.queuePreview.length > 10)) throw new Error('Invalid execution queue preview');
  const preview = (s.queuePreview ?? []).map(p => {
    if (!actions.has(p.action)) throw new Error('Unknown queued action');
    const acceptedAt = integer(p.acceptedAtMs);
    if (acceptedAt > at + 5000) throw new Error('Queued action has a future acceptance time');
    return { action: p.action, priorityClass: integer(p.priorityClass), estimatedGas: gas(p.estimatedGas), acceptedAt };
  });
  const counts = Object.fromEntries(['pendingCount', 'activeIntents', 'submittedIntents', 'queuedIntents'].map(k => [k, integer(s[k])]));
  if (counts.queuedIntents === 0 && preview.length) throw new Error('Execution queue count disagrees with preview');
  const previewAvailable = hasPreview && (counts.queuedIntents === 0 || preview.length > 0);
  return { available: true, sourceAt: at, block: String(block), blockAt, revision: publication.queueRevision,
    ...counts, blockGasLimit, queuedGas, submittedGas, pendingGas, saturationPct: s.saturationPct,
    capacityBlocks: Number(blocks), preview, previewAvailable, personalRank: null,
    reason: '全球执行队列；未查询个人地址与 intent 排名。Gas 容量折算不是成交时间。' };
}

// Anonymous Centrifuge JSON connection with a read-only public subscription.
// Node uses WebSocket; Workers uses a fetch upgrade and its returned socket.
export async function readExecutionQueue({ fetcher = fetch, socketFactory, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let socket, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { socket?.close(); } catch { /* Connecting sockets can already be closed. */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Execution queue subscription timed out')), timeoutMs);
    const send = () => socket.send(JSON.stringify({ id: 1, connect: { name: 'papertrade-monitor', version: '0.1.0' } }) + '\n' + JSON.stringify({ id: 2, subscribe: { channel: 'pressure:current' } }));
    const message = event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 65536) throw new Error('Invalid execution queue frame');
        for (const line of event.data.split('\n').filter(Boolean)) {
          const reply = JSON.parse(line);
          if (reply.error || reply.push?.disconnect) throw new Error('Execution queue subscription rejected');
          const data = reply.push?.channel === 'pressure:current' ? reply.push.pub?.data : reply.subscribe?.publications?.at(-1)?.data;
          if (data) { finish(null, parseExecutionQueue(data)); return; }
          if (!Object.keys(reply).length && socket.readyState === 1) socket.send('{}');
        }
      } catch (error) { finish(error); }
    };
    (async () => {
      const isWorker = typeof WebSocketPair !== 'undefined';
      if (socketFactory || !isWorker) {
        socket = socketFactory ? socketFactory(STREAM_URL) : new WebSocket(STREAM_URL);
        socket.addEventListener('open', () => { try { send(); } catch (error) { finish(error); } });
      } else {
        const response = await fetcher(STREAM_URL.replace('wss:', 'https:'), { headers: { Upgrade: 'websocket' }, signal: AbortSignal.timeout(timeoutMs) });
        socket = response.webSocket;
        if (response.status !== 101 || !socket) throw new Error('Execution queue WebSocket upgrade failed');
      }
      if (settled) { try { socket.close(); } catch {} return; }
      socket.addEventListener('message', message);
      socket.addEventListener('error', () => finish(new Error('Execution queue connection failed')));
      socket.addEventListener('close', () => finish(new Error('Execution queue closed before publication')));
      if (isWorker && !socketFactory) { socket.accept(); send(); }
    })().catch(error => finish(error));
  });
}
