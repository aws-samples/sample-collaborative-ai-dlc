-- One row per intent run with the headline numbers for a portfolio view.
-- stages_started counts stages reached so far, not the plan: stage rows only
-- exist once a stage starts or is skipped.
CREATE OR REPLACE VIEW intent_progress AS
SELECT
  e.*,
  date_diff('hour', e.started_at, coalesce(e.completed_at, CAST(current_timestamp AS timestamp))) AS age_hours,
  coalesce(s.stages_started, 0)    AS stages_started,
  coalesce(s.stages_succeeded, 0)  AS stages_succeeded,
  coalesce(s.stages_skipped, 0)    AS stages_skipped,
  coalesce(s.stages_failed, 0)     AS stages_failed,
  coalesce(s.stage_restarts, 0)    AS stage_restarts,
  coalesce(s.agent_hours, 0)       AS agent_hours,
  coalesce(s.human_wait_hours, 0)  AS human_wait_hours,
  coalesce(g.gates_pending, 0)     AS gates_pending,
  coalesce(g.gates_answered, 0)    AS gates_answered,
  coalesce(g.gates_rejected, 0)    AS gates_rejected,
  g.oldest_pending_gate_at,
  coalesce(st.rewinds, 0)          AS rewinds,
  coalesce(st.revisions, 0)        AS revisions,
  coalesce(u.units_total, 0)       AS units_total,
  coalesce(u.units_merged, 0)      AS units_merged,
  coalesce(u.units_failed, 0)      AS units_failed
FROM executions e
LEFT JOIN (
  SELECT execution_id,
         count(*)                                          AS stages_started,
         count_if(state = 'SUCCEEDED')                     AS stages_succeeded,
         count_if(state = 'SKIPPED')                       AS stages_skipped,
         count_if(state = 'FAILED')                        AS stages_failed,
         sum(attempt)                                      AS stage_restarts,
         round(sum(greatest(agent_seconds, 0)) / 3600.0, 2) AS agent_hours,
         round(sum(human_wait_seconds) / 3600.0, 2)        AS human_wait_hours
  FROM stages GROUP BY execution_id
) s ON s.execution_id = e.execution_id
LEFT JOIN (
  SELECT execution_id,
         count_if(status = 'pending')                               AS gates_pending,
         count_if(status IN ('answered', 'approved', 'rejected'))  AS gates_answered,
         count_if(status = 'rejected')                              AS gates_rejected,
         min(CASE WHEN status = 'pending' THEN created_at END)      AS oldest_pending_gate_at
  FROM gates GROUP BY execution_id
) g ON g.execution_id = e.execution_id
LEFT JOIN (
  SELECT execution_id,
         count_if(kind = 'rewind')   AS rewinds,
         count_if(kind = 'revision') AS revisions
  FROM steering GROUP BY execution_id
) st ON st.execution_id = e.execution_id
LEFT JOIN (
  SELECT execution_id,
         count(*)                      AS units_total,
         count_if(state = 'MERGED')    AS units_merged,
         count_if(state IN ('FAILED', 'BLOCKED')) AS units_failed
  FROM units GROUP BY execution_id
) u ON u.execution_id = e.execution_id;

-- Every human decision in one log: gate answers, approval receipts and
-- steering. A gate answer usually also writes a receipt, so filter on source
-- rather than counting all rows as separate decisions.
CREATE OR REPLACE VIEW decision_log AS
SELECT execution_id, 'gate' AS source, kind, status AS outcome, answered_by AS decided_by,
       answered_at AS decided_at, stage_instance_id, unit_slug, prompt AS summary
FROM gates
WHERE answered_at IS NOT NULL
UNION ALL
SELECT execution_id, 'approval', kind, choice, decided_by, decided_at, stage_instance_id, unit_slug,
       CASE WHEN is_current THEN 'current' ELSE 'superseded by a later attempt' END
FROM approvals
UNION ALL
SELECT execution_id, 'steering', kind, status, created_by, created_at, target_stage_id, NULL, message
FROM steering
