-- Agent usage samples (METRIC# rows), with the common measures pulled out.
-- The full bag is in metrics_json; its keys vary by agent and stage.
CREATE OR REPLACE VIEW metrics AS
SELECT
  execution_id,
  json_extract_scalar(item, '$.metricId')                                   AS metric_id,
  json_extract_scalar(item, '$.stageInstanceId')                            AS stage_instance_id,
  json_extract_scalar(item, '$.unitSlug')                                   AS unit_slug,
  json_extract_scalar(item, '$.resolvedModel')                              AS resolved_model,
  try_cast(json_extract_scalar(item, '$.metrics.tokensInput') AS bigint)    AS tokens_input,
  try_cast(json_extract_scalar(item, '$.metrics.tokensOutput') AS bigint)   AS tokens_output,
  try_cast(json_extract_scalar(item, '$.metrics.credits') AS double)        AS credits,
  try_cast(json_extract_scalar(item, '$.metrics.contextWindowPct') AS double) AS context_window_pct,
  json_format(json_extract(item, '$.metrics'))                              AS metrics_json,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.timestamp'))) AS timestamp) AS recorded_at
FROM latest
WHERE record_type = 'metric';

-- Knowledge-graph context the agents read (READ# rows): one row per tool call.
CREATE OR REPLACE VIEW graph_reads AS
SELECT
  execution_id,
  json_extract_scalar(item, '$.readId')                            AS read_id,
  json_extract_scalar(item, '$.stageInstanceId')                   AS stage_instance_id,
  json_extract_scalar(item, '$.unitSlug')                          AS unit_slug,
  json_extract_scalar(item, '$.tool')                              AS tool,
  try_cast(json_extract_scalar(item, '$.bytes') AS bigint)         AS bytes,
  try_cast(json_extract_scalar(item, '$.resultCount') AS integer)  AS result_count,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.timestamp'))) AS timestamp) AS read_at
FROM latest
WHERE record_type = 'read'
