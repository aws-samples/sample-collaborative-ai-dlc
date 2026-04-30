# Question and GeneralInfo Quick Reference

## ✅ ALWAYS Link Questions

```javascript
// After creating ANY artifact, link Questions that influenced it
add_edge(
  fromLabel: "Question",
  fromId: "q-performance-target",
  toLabel: "Requirement", // or UserStory, Task, GeneralInfo, CodeFile
  toId: "req-api-performance",
  edgeLabel: "INFLUENCES"
)
```

## ✅ ALWAYS Link GeneralInfo

```javascript
// 1. Load related artifacts first
const requirements = await list_nodes({ label: "Requirement" });
const userStories = await list_nodes({ label: "UserStory" });
const questions = await list_nodes({ label: "Question" });

// 2. Create GeneralInfo with edges to Requirements/UserStories/Tasks
add_node(label: "GeneralInfo", id: "design-api", properties: {
  type: "application-design",
  title: "REST API Design",
  content: "..."
}, edges: [
  { direction: "to", label: "Requirement", id: "req-api", edgeLabel: "RELATES_TO" },
  { direction: "to", label: "UserStory", id: "story-login", edgeLabel: "RELATES_TO" }
])

// 3. Link Questions that influenced the GeneralInfo
add_edge(
  fromLabel: "Question",
  fromId: "q-auth-method",
  toLabel: "GeneralInfo",
  toId: "design-api",
  edgeLabel: "INFLUENCES"
)
```

## ❌ NEVER Do This

```javascript
// Creating GeneralInfo without edges - WRONG!
add_node(label: "GeneralInfo", id: "design-api", properties: {
  type: "application-design",
  title: "REST API Design",
  content: "..."
})
// This creates an orphaned node that agents cannot discover!
```

## Edge Rules

| From | To | Edge Label | Method |
|------|-----|-----------|---------|
| Question | Requirement | INFLUENCES | `add_edge` after creation |
| Question | UserStory | INFLUENCES | `add_edge` after creation |
| Question | Task | INFLUENCES | `add_edge` after creation |
| Question | GeneralInfo | INFLUENCES | `add_edge` after creation |
| Question | CodeFile | INFLUENCES | `add_edge` after creation |
| GeneralInfo | Requirement | RELATES_TO | `edges` in `add_node` |
| GeneralInfo | UserStory | RELATES_TO | `edges` in `add_node` |
| GeneralInfo | Task | RELATES_TO | `edges` in `add_node` |

## GeneralInfo Types

| Type | Use For | Link To (RELATES_TO) | Link From (INFLUENCES) |
|------|---------|---------|---------|
| `reverse-engineering` | Existing code analysis | Requirements | Questions |
| `application-design` | Component design, architecture | Requirements, UserStories | Questions |
| `api-documentation` | API specs, endpoints | Requirements, UserStories, Tasks | Questions |
| `architecture-decision` | Design decisions, patterns | Requirements | Questions |
| `technical-specification` | Data models, protocols | Requirements, UserStories | Questions |

## Validation Checklist

**For Questions:**
- [ ] After creating Requirement/UserStory/Task/GeneralInfo/CodeFile, identify which Questions influenced it
- [ ] Use `add_edge` to link each Question with `INFLUENCES` edge label
- [ ] Verify Question IDs exist in graph

**For GeneralInfo:**
- [ ] Has descriptive `id`
- [ ] Has `type` property
- [ ] Has `title` property
- [ ] Has meaningful `content`
- [ ] Has `edges` array with at least one edge (RELATES_TO)
- [ ] All edges in array use `RELATES_TO` label
- [ ] All edge IDs exist in graph
- [ ] Edge direction is `"to"`
- [ ] After creation, link Questions via `add_edge` with `INFLUENCES`
