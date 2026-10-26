# Notification events

The platform can publish a small feed of activity to an Amazon EventBridge bus, so other systems can react to it: a chat notification when a gate needs a human, a ticket comment when a discussion is resolved, an audit record when a space is created. It is off by default.

## Enable it

Set in your Terraform variables:

```hcl
notification_events_enabled = true

# Optional:
notification_event_bus_name = ""                     # empty: <project_name>-<environment>-events
notification_event_source   = "collaborative-ai-dlc" # the events' source, for rule patterns
```

The deployment creates the bus and lets the publishing Lambdas (projects, discussions and the v2 orchestrator) put events on it. It creates no rules or targets. Add your own, in this deployment or another, matching on the source and detail types below. The bus name and ARN are in the `notification_event_bus_name` and `notification_event_bus_arn` outputs.

## Delivery

Publishing is best-effort:

- It never fails or blocks the action that triggered it. Each publish gives up after two seconds, and a missing bus, missing permission or EventBridge error only logs a warning.
- There's no retry, so a consumer that must not miss an event should reconcile against the platform's API.
- `gate.pending` is published from a durable orchestrator step, so a replayed execution doesn't publish it twice. The others are published once per request.

## Events

Every event has `source` set to `notification_event_source` and `detail-type` set to the event name. Text fields are cut to 1,000 characters.

### `space.created`

A space (project) was created.

| Field                           | Description                                                |
| ------------------------------- | ---------------------------------------------------------- |
| `projectId`                     | the new space's id                                         |
| `name`                          | its name                                                   |
| `createdById`, `createdByEmail` | who created it                                             |
| `gitProvider`                   | the space's git provider, for example `github` or `gitlab` |
| `repoCount`                     | repositories attached at creation                          |
| `createdAt`                     | ISO 8601 timestamp                                         |

### `gate.pending`

An intent is waiting for a human at a gate.

| Field                                  | Description                              |
| -------------------------------------- | ---------------------------------------- |
| `projectId`, `intentId`, `executionId` | where                                    |
| `humanTaskId`                          | the gate's task id                       |
| `stage`                                | the stage label                          |
| `kind`                                 | the gate kind, or null                   |
| `prompt`                               | the question shown to the human, or null |

### `discussion.message`

A message was posted to an intent discussion.

| Field                                                | Description                        |
| ---------------------------------------------------- | ---------------------------------- |
| `projectId`, `intentId`, `discussionId`, `messageId` | where                              |
| `entityType`                                         | what the discussion is attached to |
| `authorId`, `authorName`                             | who posted it                      |
| `excerpt`                                            | the message text                   |
| `mentions`                                           | mentioned user ids                 |
| `createdAt`                                          | ISO 8601 timestamp                 |

### `discussion.resolved`

An intent discussion was resolved.

| Field                                   | Description                        |
| --------------------------------------- | ---------------------------------- |
| `projectId`, `intentId`, `discussionId` | where                              |
| `entityType`                            | what the discussion is attached to |
| `resolvedById`, `resolvedByName`        | who resolved it                    |
| `resolutionSummary`                     | the resolution text                |
| `resolvedAt`                            | ISO 8601 timestamp                 |

## Example rule

```hcl
resource "aws_cloudwatch_event_rule" "gates" {
  event_bus_name = "collaborative-ai-dlc-dev-events"
  event_pattern = jsonencode({
    source        = ["collaborative-ai-dlc"]
    "detail-type" = ["gate.pending"]
  })
}
```

Event details contain user names, email addresses and message text, so treat targets as holding personal data.
