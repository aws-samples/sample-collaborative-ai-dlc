-- The current state of every reported row: the newest change per (pk, sk),
-- dropping rows whose newest change is a delete. Kinesis can deliver a change
-- twice or out of order; ordering by the change time handles both.
CREATE OR REPLACE VIEW latest AS
SELECT record_type, pk, sk, execution_id, entity_type, event_time, item
FROM (
  SELECT c.*,
         row_number() OVER (PARTITION BY pk, sk ORDER BY event_ts_us DESC, event_id DESC) AS rn
  FROM changes c
)
WHERE rn = 1 AND event_name <> 'REMOVE'
