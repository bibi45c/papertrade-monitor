import https from 'node:https';

// Read-only production acceptance. This never loads deployment credentials.
const origin = 'https://papertrade-monitor.papertrade-monitor.workers.dev';
const publicDns = process.argv.includes('--public-dns');
let verifiedAddress;
if (publicDns) {
  const hostname = new URL(origin).hostname;
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
    headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Public DNS query failed');
  const dns = await response.json();
  verifiedAddress = dns.Answer?.find(x => x.type === 1)?.data;
  if (!verifiedAddress) throw new Error('No public A record available');
  console.log(JSON.stringify({ dnsMode: 'per-request public DNS', hostname, address: verifiedAddress,
    certificateValidation: true, systemDnsChanged: false }));
}

function request(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = { method };
    // Keep the hostname, SNI and standard TLS certificate verification intact.
    if (verifiedAddress) options.lookup = (_host, lookupOptions, done) => lookupOptions?.all
      ? done(null, [{ address: verifiedAddress, family: 4 }]) : done(null, verifiedAddress, 4);
    const req = https.request(new URL(path, origin), options, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 2_000_000) req.destroy(new Error('Response exceeds verification size limit'));
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.setTimeout(25000, () => req.destroy(new Error('HTTPS request timed out')));
    req.on('error', reject); req.end();
  });
}
async function json(path) {
  const result = await request(path);
  if (result.status !== 200) throw new Error(`${path}: HTTP ${result.status}`);
  return JSON.parse(result.body);
}
const health = await json('/api/health');
if (health.storage !== 'configured' || health.mode !== 'public-read-only') throw new Error('Unexpected storage or mode');
const live = await json('/api/live');
const failed = Object.entries(live.sources).filter(([, source]) => !source.ok).map(([name]) => name);
console.log(JSON.stringify({ check: 'live', collectedAt: live.collectedAt, failedSources: failed }));
if (failed.length || Date.now() - live.collectedAt > 30000) throw new Error('Live data unavailable or stale');
const rejected = await request('/api/live', 'POST');
if (rejected.status !== 405) throw new Error('Public API must reject POST');

const deadline = Date.now() + 15 * 60000;
let history;
for (;;) {
  history = await json('/api/history?hours=1');
  const rows = history.rows.filter(r => r.paper_supply !== null && r.btc_mid !== null && r.eth_mid !== null);
  const first = rows[0], last = rows.at(-1);
  console.log(JSON.stringify({ check: 'cron', samples: history.rows.length, validSamples: rows.length,
    firstAt: first?.collected_at ?? null, lastAt: last?.collected_at ?? null }));
  if (rows.length >= 2 && last.collected_at - first.collected_at >= 60000 && Date.now() - last.collected_at < 180000) break;
  if (Date.now() >= deadline) throw new Error('No two fresh cloud samples within the verification window');
  await new Promise(resolve => setTimeout(resolve, 60000));
}
const day = new Date().toISOString().slice(0, 10);
const csv = await request('/api/export.csv?day=' + day);
if (csv.status !== 200 || !csv.headers['content-type']?.startsWith('text/csv') ||
    !csv.body.startsWith('collected_at,') || csv.body.trim().split('\n').length < 3) throw new Error('CSV export verification failed');
const latest = await json('/api/latest');
const latestFailures = Object.entries(latest.snapshot.sources).filter(([, source]) => !source.ok).map(([name]) => name);
console.log(JSON.stringify({ check: 'complete', origin, samples: history.rows.length, csvDataRows: csv.body.trim().split('\n').length - 1,
  latestCollectedAt: latest.snapshot.collectedAt, latestFailedSources: latestFailures, publicPostStatus: rejected.status }));
if (latestFailures.length) throw new Error('Latest persisted sample contains source failures');
