-- Human gates: what the agent or engine asked, and how and when it was
-- answered. status: pending | answered | approved | rejected | superseded
-- (superseded = retired by a cancel or rewind, never answered).
-- checkpoint is set when the gate is a consolidated confirmation rather than
-- an ordinary question.
CREATE OR REPLACE VIEW gates AS
SELECT
  execution_id,
  json_extract_scalar(item, '$.humanTaskId')                     AS human_task_id,
  json_extract_scalar(item, '$.stageInstanceId')                 AS stage_instance_id,
  json_extract_scalar(item, '$.unitSlug')                        AS unit_slug,
  json_extract_scalar(item, '$.kind')                            AS kind,
  json_extract_scalar(item, '$.detail.checkpoint')               AS checkpoint,
  json_extract_scalar(item, '$.status')                          AS status,
  json_extract_scalar(item, '$.prompt')                          AS prompt,
  json_format(json_extract(item, '$.answer'))                    AS answer_json,
  json_extract_scalar(item, '$.answeredByName')                  AS answered_by,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.createdAt')))  AS timestamp) AS created_at,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.answeredAt'))) AS timestamp) AS answered_at,
  date_diff(
    'second',
    CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.createdAt'))) AS timestamp),
    coalesce(
      CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.answeredAt'))) AS timestamp),
      CAST(current_timestamp AS timestamp)
    )
  )                                                              AS wait_seconds
FROM latest
WHERE record_type = 'human'
