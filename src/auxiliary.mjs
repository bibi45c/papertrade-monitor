import { URLS, parseProtocolHistory } from './collect.mjs';
import { readJson } from './read-retry.mjs';
import { scanGovernance, readWebVersions } from './watch.mjs';

// Separate invocation and state: an auxiliary failure cannot erase a core minute.
export async function collectAuxiliary({ fetcher = fetch, previous = null, now = Date.now(), checkWeb = true } = {}) {
  const result = { collectedAt: now, sources: {}, protocolHours: null, governance: null, web: previous?.web ?? null };
  const jobs = [
    ['protocolHistory', () => readJson(URLS.paper + '/query/protocol/history?interval=1h', undefined, fetcher).then(parseProtocolHistory)],
    ['governance', () => scanGovernance({ fetcher, previous: previous?.governance ?? null })],
    ...(checkWeb ? [['web', () => readWebVersions({ fetcher })]] : []),
  ];
  const results = await Promise.allSettled(jobs.map(([, read]) => read()));
  results.forEach((r, i) => {
    const key = jobs[i][0];
    if (r.status === 'fulfilled') {
      const v = r.value;
      result.sources[key] = { ok: true, at: v.sourceAt ?? v.at, block: v.block ?? null };
      if (key === 'protocolHistory') result.protocolHours = v.hours;
      else if (key === 'governance') {
        result.governance = { ...v, stale: v.readErrors.length > 0 };
        if (v.readErrors.length) result.sources[key] = { ...result.sources[key], ok: false, partial: true, error: v.readErrors[0].error };
      }
      else {
        const changed = previous?.web && (previous.web.app !== v.app || previous.web.docs !== v.docs);
        result.web = { ...v, changedAt: changed ? v.at : previous?.web?.changedAt ?? null, previous: changed ? { app: previous.web.app, docs: previous.web.docs, at: previous.web.at } : previous?.web?.previous ?? null };
      }
    } else {
      result.sources[key] = { ok: false, at: null, error: String(r.reason?.message ?? r.reason).slice(0, 180) };
      if (key === 'governance' && previous?.governance) result.governance = { ...previous.governance, stale: true };
    }
  });
  if (!checkWeb && previous?.sources?.web) result.sources.web = { ...previous.sources.web, retained: true };
  result.completedAt = Date.now();
  return result;
}

export function attachAuxiliary(snapshot, auxiliary) {
  if (!snapshot || !auxiliary) return snapshot;
  return { ...snapshot, protocolHours: auxiliary.protocolHours, governance: auxiliary.governance, web: auxiliary.web,
    auxiliaryAt: auxiliary.completedAt, sources: { ...snapshot.sources, ...Object.fromEntries(Object.entries(auxiliary.sources ?? {}).filter(([k, v]) => ['governance', 'web', 'protocolHistory'].includes(k) && v).map(([k, v]) => [k, { ...v, retained: true }])) } };
}
