/** Shared semantic tool label map — used by ActivityFeed and AgentFocusCard */
export const TOOL_LABELS: Record<string, string> = {
  add_node: 'Updating graph',
  update_node: 'Updating graph',
  add_edge: 'Updating graph',
  get_sprint_graph: 'Reading sprint state',
  get_node: 'Reading graph',
  list_nodes: 'Reading graph',
  find_nodes: 'Reading graph',
  get_neighbors: 'Reading graph',
  get_dependency_chain: 'Reading graph',
  get_unblocked_tasks: 'Checking task queue',
  launch_construction_agent: 'Spawning agent',
  trigger_pr_creation: 'Creating PR',
  ask_question: '⚠ Asking question',
  get_previous_sprint_summary: 'Loading sprint history',
  get_previous_sprint_graph: 'Loading sprint history',
  carry_forward_knowledge: 'Importing knowledge',
};

export function semanticTool(name: string): string {
  if (!name) return 'Agent working';
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ');
}
