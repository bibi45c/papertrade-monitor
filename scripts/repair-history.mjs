// Reconstructed public history is kept separately; never modifies D1 or original shards.
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import https from 'node:https';
import { scanGovernance, mergeBlockRanges } from '../src/watch.mjs';
import { parseProtocolHistory, URLS } from '../src/collect.mjs';
import { readJson } from '../src/read-retry.mjs';

const root = new URL('../data/recovered/', import.meta.url);
await mkdir(root, { recursive: true });
const monitor = new URL(process.env.MONITOR_ORIGIN ?? 'https://papertrade-monitor.papertrade-monitor.workers.dev').origin;
if (!monitor.startsWith('https://')) throw new Error('MONITOR_ORIGIN must use HTTPS');
const publicDns = process.argv.includes('--public-dns');
let address;
if (publicDns) {
  const dns = await readJson('https://cloudflare-dns.com/dns-query?name=' + new URL(monitor).hostname + '&type=A', undefined,
    (url, init) => fetch(url, { ...init, headers: { ...init?.headers, Accept: 'application/dns-json' } }));
  address = dns.Answer?.find(a => a.type === 1)?.data;
  if (!address) throw new Error('No public monitor DNS address');
}
const fetcher = async (url, options = {}) => {
  if (!address || new URL(url).origin !== monitor) return fetch(url, options);
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...options, lookup: (_host, opts, done) => opts?.all ? done(null, [{ address, family: 4 }]) : done(null, address) }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { chunks.push(chunk); size += chunk.length; if (size > 8_000_000) req.destroy(new Error('Recovery response too large')); });
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('Recovery timeout'))); req.on('error', reject); req.end();
  });
};

const seedPath = new URL('governance-checkpoint.json', root);
let seed;
try { seed = JSON.parse(await readFile(seedPath, 'utf8')).state; }
catch (error) { if (error.code !== 'ENOENT') throw error; seed = (await readJson(monitor + '/api/latest', undefined, fetcher)).snapshot?.governance; }
if (!seed) throw new Error('No governance checkpoint is available');
seed = { ...seed, gaps: mergeBlockRanges(seed.gaps) };
const initialMissing = seed.gaps.reduce((n, [a, b]) => n + b - a + 1, 0);
const rawHistory = await readJson(URLS.paper + '/query/protocol/history?interval=1h');
const hours = parseProtocolHistory(rawHistory, Number.MAX_SAFE_INTEGER);
await writeFile(new URL('protocol-hours.json', root), JSON.stringify({ provenance: 'reconstructed-from-public-hourly-history', fetchedAt: Date.now(), source: URLS.paper + '/query/protocol/history?interval=1h', sourceAt: hours.sourceAt, revision: hours.revision, hours: hours.hours, rawHistory }, null, 2));
let runs = 0;
const limitAt = process.argv.indexOf('--runs'), maxRuns = limitAt >= 0 ? Number(process.argv[limitAt + 1]) : 60;
if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 100) throw new Error('--runs must be 1-100');
do {
  let state;
  try { state = await scanGovernance({ previous: seed }); }
  catch (error) { state = { ...seed, readErrors: [{ error: String(error.message ?? error).slice(0, 180) }], coverageComplete: false }; }
  runs++;
  await writeFile(seedPath, JSON.stringify({ provenance: 'reconstructed-from-public-contract-logs', recoveredAt: Date.now(), source: URLS.rpc, state }, null, 2));
  await appendFile(new URL('governance-progress.jsonl', root), JSON.stringify({ at: Date.now(), missingBlocks: state.gaps.reduce((n, [a, b]) => n + b - a + 1, 0), gaps: state.gaps.length, readErrors: state.readErrors }) + '\n');
  seed = state;
  if (state.gaps.length === 0) break;
  if (state.readErrors.some(e => !/rate limit|temporar|timeout/i.test(e.error))) break;
  if (runs < maxRuns) await new Promise(resolve => setTimeout(resolve, state.readErrors.length ? 10000 : 1000));
} while (runs < maxRuns);
console.log(JSON.stringify({ hoursRecovered: hours.hours.length, initialMissingBlocks: initialMissing, remainingMissingBlocks: seed.gaps.reduce((n, [a, b]) => n + b - a + 1, 0), remainingGaps: seed.gaps.length, runs, readErrors: seed.readErrors, output: root.pathname, originalMinuteSnapshotsChanged: false }));
