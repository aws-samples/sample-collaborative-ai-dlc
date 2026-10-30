-- Human course corrections. kind: gate-steer | revision | rewind | artifact-edit.
-- A rewind is rework: count these per intent to see how often work restarted.
CREATE OR REPLACE VIEW steering AS
SELECT
  execution_id,
  json_extract_scalar(item, '$.steerId')                   AS steer_id,
  json_extract_scalar(item, '$.kind')                      AS kind,
  json_extract_scalar(item, '$.status')                    AS status,
  json_extract_scalar(item, '$.message')                   AS message,
  json_extract_scalar(item, '$.targetStageId')             AS target_stage_id,
  json_extract_scalar(item, '$.targetGateId')              AS target_gate_id,
  json_extract_scalar(item, '$.createdByName')             AS created_by,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.createdAt')))  AS timestamp) AS created_at,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.consumedAt'))) AS timestamp) AS consumed_at
FROM latest
WHERE record_type = 'steer'
