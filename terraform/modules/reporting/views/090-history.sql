-- Status history, from the change log rather than the current state. These
-- are what the platform's own tables can't answer: how long a run spent in
-- each status, and when each stage moved. Backfilled rows only know the state
-- at backfill time, so history before the lake was switched on is one point.
CREATE OR REPLACE VIEW execution_status_history AS
SELECT execution_id, status, entered_at,
       lead(entered_at) OVER (PARTITION BY execution_id ORDER BY entered_at) AS left_at
FROM (
  SELECT execution_id, status, entered_at,
         lag(status) OVER (PARTITION BY execution_id ORDER BY entered_at) AS previous_status
  FROM (
    SELECT execution_id,
           json_extract_scalar(item, '$.status') AS status,
           CAST(from_iso8601_timestamp(event_time) AS timestamp) AS entered_at
    FROM changes
    WHERE record_type = 'meta' AND event_name <> 'REMOVE'
  )
)
WHERE previous_status IS NULL OR previous_status <> status;

CREATE OR REPLACE VIEW stage_state_history AS
SELECT execution_id, stage_instance_id, stage_id, unit_slug, attempt, state, entered_at,
       lead(entered_at) OVER (PARTITION BY execution_id, stage_instance_id ORDER BY entered_at) AS left_at
FROM (
  SELECT *,
         lag(state || '#' || CAST(attempt AS varchar))
           OVER (PARTITION BY execution_id, stage_instance_id ORDER BY entered_at) AS previous
  FROM (
    SELECT execution_id,
           json_extract_scalar(item, '$.stageInstanceId')  AS stage_instance_id,
           json_extract_scalar(item, '$.stageId')          AS stage_id,
           json_extract_scalar(item, '$.unitSlug')         AS unit_slug,
           coalesce(try_cast(json_extract_scalar(item, '$.attempt') AS integer), 0) AS attempt,
           json_extract_scalar(item, '$.state')            AS state,
           CAST(from_iso8601_timestamp(event_time) AS timestamp) AS entered_at
    FROM changes
    WHERE record_type = 'stage' AND event_name <> 'REMOVE'
  )
)
WHERE previous IS NULL OR previous <> state || '#' || CAST(attempt AS varchar)
