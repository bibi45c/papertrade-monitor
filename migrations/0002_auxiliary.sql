CREATE TABLE IF NOT EXISTS auxiliary_state (
  name TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

-- Seed from the last historical governance state before the first core-only run.
INSERT OR IGNORE INTO auxiliary_state (name, updated_at, payload)
SELECT 'current', collected_at, json_object(
  'collectedAt', collected_at,
  'completedAt', json_extract(payload, '$.completedAt'),
  'governance', json_set(json_extract(payload, '$.governance'), '$.gaps', json(COALESCE((
    SELECT json_group_array(json(value)) FROM (
      SELECT DISTINCT j.value AS value FROM snapshots AS history, json_each(history.payload, '$.governance.gaps') AS j
      WHERE j.type = 'array'
    )
  ), '[]'))),
  'protocolHours', json_extract(payload, '$.protocolHours'),
  'web', json_extract(payload, '$.web'),
  'sources', json_object(
    'governance', json_extract(payload, '$.sources.governance'),
    'protocolHistory', json_extract(payload, '$.sources.protocolHistory'),
    'web', json_extract(payload, '$.sources.web')
  )
)
FROM snapshots
WHERE json_type(payload, '$.governance') = 'object'
ORDER BY collected_at DESC LIMIT 1;
