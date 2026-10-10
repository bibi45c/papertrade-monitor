import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const cli = new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url);
function wrangler(args) {
  const command = spawnSync(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { stdio: 'inherit', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
  if (command.status !== 0) process.exit(command.status ?? 1);
}
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
if (!config.d1_databases?.some(d => d.binding === 'DB' && d.database_id)) {
  wrangler(['d1', 'create', 'papertrade-monitor', '--binding', 'DB', '--update-config', '--location', 'apac']);
}
wrangler(['d1', 'migrations', 'apply', 'papertrade-monitor', '--remote']);
console.log('D1 binding and initial migration are ready. Run npm run deploy to publish.');
