-- Approval receipts: the durable record that an authorization was given
-- (plan approval, stage approval, sensor override, ...). Receipts belong to a
-- stage attempt, so a rewind leaves earlier ones in place but no longer in
-- force: is_current is false for those.
CREATE OR REPLACE VIEW approvals AS
SELECT
  r.execution_id,
  r.kind,
  r.stage_instance_id,
  s.stage_id,
  s.phase,
  r.unit_slug,
  r.attempt,
  r.choice,
  r.decided_by,
  r.decided_at,
  r.human_task_id,
  (s.attempt IS NULL OR r.attempt = s.attempt) AS is_current
FROM (
  SELECT
    execution_id,
    json_extract_scalar(item, '$.kind')                                   AS kind,
    json_extract_scalar(item, '$.stageInstanceId')                        AS stage_instance_id,
    json_extract_scalar(item, '$.unitSlug')                               AS unit_slug,
    coalesce(try_cast(json_extract_scalar(item, '$.attempt') AS integer), 0) AS attempt,
    coalesce(json_extract_scalar(item, '$.choice'), json_format(json_extract(item, '$.choice'))) AS choice,
    json_extract_scalar(item, '$.decidedByName')                          AS decided_by,
    json_extract_scalar(item, '$.humanTaskId')                            AS human_task_id,
    CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.decidedAt'))) AS timestamp) AS decided_at
  FROM latest
  WHERE record_type = 'receipt'
) r
LEFT JOIN stages s
  ON s.execution_id = r.execution_id AND s.stage_instance_id = r.stage_instance_id
