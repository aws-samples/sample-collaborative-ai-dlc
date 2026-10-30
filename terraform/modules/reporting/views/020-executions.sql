-- One row per intent run (the META row). project_id is the platform's space
-- ID; names live in the knowledge graph, which this lake doesn't read yet.
CREATE OR REPLACE VIEW executions AS
SELECT
  execution_id,
  json_extract_scalar(item, '$.projectId')                     AS project_id,
  json_extract_scalar(item, '$.intentId')                      AS intent_id,
  json_extract_scalar(item, '$.title')                         AS title,
  json_extract_scalar(item, '$.status')                        AS status,
  json_extract_scalar(item, '$.status') IN ('CREATED', 'RUNNING', 'WAITING') AS is_active,
  json_extract_scalar(item, '$.pendingHumanTaskId') IS NOT NULL AS waiting_on_human,
  json_extract_scalar(item, '$.currentPhase')                  AS current_phase,
  json_extract_scalar(item, '$.currentStage')                  AS current_stage,
  json_extract_scalar(item, '$.workflowId')                    AS workflow_id,
  CAST(json_extract(item, '$.workflowVersion') AS varchar)     AS workflow_version,
  json_extract_scalar(item, '$.scope')                         AS scope,
  json_extract_scalar(item, '$.agentCli')                      AS agent_cli,
  json_extract_scalar(item, '$.prStrategy')                    AS pr_strategy,
  json_extract_scalar(item, '$.constructionGateAutonomy')      AS construction_gate_autonomy,
  json_extract_scalar(item, '$.constructionAutonomyMode')      AS construction_autonomy_mode,
  json_extract_scalar(item, '$.rewindFromStageId')             AS rewind_from_stage_id,
  json_extract_scalar(item, '$.starterName')                   AS started_by,
  json_extract_scalar(item, '$.source.provider')               AS source_provider,
  json_extract_scalar(item, '$.source.resourceId')             AS source_ticket,
  json_extract_scalar(item, '$.source.resourceUrl')            AS source_url,
  json_extract_scalar(item, '$.failureReason')                 AS failure_reason,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.startedAt')))   AS timestamp) AS started_at,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.updatedAt')))   AS timestamp) AS updated_at,
  CAST(try(from_iso8601_timestamp(json_extract_scalar(item, '$.completedAt'))) AS timestamp) AS completed_at
FROM latest
-- A deleted intent can leave a bare META row holding only its output counter.
WHERE record_type = 'meta' AND entity_type = 'Execution'
