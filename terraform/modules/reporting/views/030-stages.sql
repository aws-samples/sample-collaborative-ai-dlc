-- One row per stage instance (per unit lane for construction stages). Rows
-- appear as stages start or are skipped, so this is not the whole plan.
-- attempt counts restarts: every rewind or retry of the stage adds one.
CREATE OR REPLACE VIEW stages AS
SELECT
  execution_id,
  stage_instance_id,
  stage_id,
  phase,
  unit_slug,
  section_index,
  state,
  attempt,
  resolved_model,
  cli,
  started_at,
  completed_at,
  wait_ms / 1000                                                          AS human_wait_seconds,
  date_diff('second', started_at, coalesce(completed_at, CAST(current_timestamp AS timestamp))) AS elapsed_seconds,
  date_diff('second', started_at, coalesce(completed_at, CAST(current_timestamp AS timestamp))) - wait_ms / 1000 AS agent_seconds
FROM (
  SELECT
    execution_id,
    json_extract_scalar(item, '$.stageInstanceId')                         AS stage_instance_id,
    json_extract_scalar(item, '$.stageId')                                 AS stage_id,
    json_extract_scalar(item, '$.phase')                                   AS phase,
    json_extract_scalar(item, '$.unitSlug')                                AS unit_slug,
    try_cast(json_extract_scalar(item, '$.sectionIndex') AS integer)       AS section_index,
    json_extract_scalar(item, '$.state')                                   AS state,
    coalesce(try_cast(json_extract_scalar(item, '$.attempt') AS integer), 0) AS attempt,
    json_extract_scalar(item, '$.resolvedModel')                           AS resolved_model,
    json_extract_scalar(item, '$.cli')                                     AS cli,
    coalesce(try_cast(json_extract_scalar(item, '$.waitMs') AS bigint), 0) AS wait_ms,
    CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.startedAt')))   AS timestamp) AS started_at,
    CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.completedAt'))) AS timestamp) AS completed_at
  FROM latest
  WHERE record_type = 'stage'
)
