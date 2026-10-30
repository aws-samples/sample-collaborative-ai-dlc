-- Deterministic post-stage checks. held = the result blocked the stage.
CREATE OR REPLACE VIEW sensor_runs AS
SELECT
  execution_id,
  json_extract_scalar(item, '$.sensorRunId')           AS sensor_run_id,
  json_extract_scalar(item, '$.stageInstanceId')       AS stage_instance_id,
  json_extract_scalar(item, '$.unitSlug')              AS unit_slug,
  json_extract_scalar(item, '$.sensorId')              AS sensor_id,
  json_extract_scalar(item, '$.kind')                  AS kind,
  json_extract_scalar(item, '$.severity')              AS severity,
  json_extract_scalar(item, '$.result')                AS result,
  coalesce(try_cast(json_extract_scalar(item, '$.held') AS boolean), false) AS held,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.timestamp'))) AS timestamp) AS run_at
FROM latest
WHERE record_type = 'sensor'
