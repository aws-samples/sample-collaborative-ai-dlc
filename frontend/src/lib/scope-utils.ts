/**
 * Canonical scope-grid utilities shared across components.
 * The canonical shape is scopeGrid[scopeId][stageId].
 * Dev mock may use inverted key order — probe both paths.
 */

export function isExecuteInScope(
  scopeGrid: Record<string, Record<string, 'EXECUTE' | 'SKIP'>>,
  stageId: string,
  scopeId: string,
): boolean {
  if (scopeGrid[scopeId]?.[stageId] === 'EXECUTE') return true;
  if (scopeGrid[stageId]?.[scopeId] === 'EXECUTE') return true;
  return false;
}
