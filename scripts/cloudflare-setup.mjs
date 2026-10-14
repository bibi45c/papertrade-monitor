import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const cli = new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url);
function wrangler(args) {
  const command = spawnSync(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { stdio: 'inherit', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
  if (command.status !== 0) process.exit(command.status ?? 1);
}
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const database = config.d1_databases?.find(d => d.binding === 'DB');
const databaseName = database?.database_name;
if (!databaseName) throw new Error('Set d1_databases.database_name with binding DB in wrangler.jsonc first');
if (!database.database_id) {
  wrangler(['d1', 'create', databaseName, '--binding', 'DB', '--update-config', '--location', 'apac']);
}
wrangler(['d1', 'migrations', 'apply', databaseName, '--remote']);
console.log('D1 binding and pending migrations are ready. Run npm run deploy to publish.');
