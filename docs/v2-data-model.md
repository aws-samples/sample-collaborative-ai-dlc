#Data-Model V2
Project lives in DynamoDB & Neptune (DDB refs Neptune and vice versa)
Project has links to repos (multi-repo) stored in DDB
Project has members stored in DDB
Project contains intents
Intent lives in dynamo but refs the neptune node and vice versa
Business data (blocks from ai-dlc v2 block definition live in neptune
Disucssions, questions, answers live in Neptune as well
Team knowledge (runtime-accrued learnings) lives in Neptune as TeamKnowledge nodes hung off the Project node (Project -HAS_KNOWLEDGE-> TeamKnowledge) — shared across all intents in the project, written by the agent via record_team_knowledge
Learning rules (runtime-accrued guardrails) live in Neptune as LearningRule nodes hung off the Project node (Project -HAS_LEARNING-> LearningRule) at the team-learnings/project-learnings layers — written via record_learning_rule, merged into the rule resolver per stage at their layer precedence
State (question pending -> ref to question, current phase and stage) is handeled in DynamoDB
Any agent execution for an intent is stored in DynamoDB
Current phase and stage are stored in DynamoDB
The agent receives all files (markdown & scripts) for the current stage during runtime (fetched from DynamoDB and S3)

The marching route is:

- relevant business data in Neptune, supporting data in DynamoDB
- we have to know at any point in time which agent is running, in which phase and stage we are
- what is happening (questions, gates, ...)
- everything has to be realtime as in v1 (discussion on every artifact & question, intent input is realtime)
