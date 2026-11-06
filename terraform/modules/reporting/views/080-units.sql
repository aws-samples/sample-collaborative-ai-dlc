-- Construction lanes and their pull requests.
CREATE OR REPLACE VIEW units AS
SELECT
  execution_id,
  json_extract_scalar(item, '$.slug')                                   AS unit_slug,
  try_cast(json_extract_scalar(item, '$.sectionIndex') AS integer)      AS section_index,
  json_extract_scalar(item, '$.kind')                                   AS kind,
  json_extract_scalar(item, '$.state')                                  AS state,
  try_cast(json_extract_scalar(item, '$.batchIndex') AS integer)        AS batch_index,
  json_extract_scalar(item, '$.failureReason')                          AS failure_reason,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.createdAt'))) AS timestamp) AS created_at,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.startedAt'))) AS timestamp) AS started_at,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.mergedAt')))  AS timestamp) AS merged_at
FROM latest
WHERE record_type = 'unit';

CREATE OR REPLACE VIEW unit_prs AS
SELECT
  execution_id,
  json_extract_scalar(item, '$.unitSlug')                               AS unit_slug,
  json_extract_scalar(item, '$.repository')                             AS repository,
  json_extract_scalar(item, '$.provider')                               AS provider,
  try_cast(json_extract_scalar(item, '$.number') AS integer)            AS pr_number,
  json_extract_scalar(item, '$.url')                                    AS url,
  json_extract_scalar(item, '$.state')                                  AS state,
  try_cast(json_extract_scalar(item, '$.commentCount') AS integer)      AS comment_count,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.createdAt'))) AS timestamp) AS created_at,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.mergedAt')))  AS timestamp) AS merged_at,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.closedAt')))  AS timestamp) AS closed_at
FROM latest
WHERE record_type = 'unitpr'
