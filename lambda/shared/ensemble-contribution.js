// Deterministic graph id for a stage persona's contribution.
export const contributionArtifactId = ({ stageId, agentRef }) =>
  `contribution-${stageId}-${agentRef}`;
