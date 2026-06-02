# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Jira Cloud support and a generic tracker provider abstraction (#194). A project can now bind to GitHub Issues and Jira Cloud independently of its code host; sprints can be started from any tracker issue.
- Phase 4 tracker-migration polish (#198): an Admin → Tracker Migration card surfaces the count of projects + sprints still on the legacy tracker shape and promotes the bulk migration from the CLI-only `migrate-tracker-fields` Lambda to a one-click button. Docs (`using-the-platform/git-integration.md`, `getting-started/setup.md`) gained a "Migrating from legacy issue integration" section.

### Notes

- No legacy code is removed by Phase 4. The `issue_integration_enabled` boolean, `issue_number` / `issue_url` Sprint fields, dual-shape readers, the per-project `MigrateTrackerCard`, the per-project `POST /projects/:id/migrate-tracker` endpoint, and the bulk `migrate-tracker-fields` Lambda all stay deployed indefinitely as safety nets for OSS forks on their own upgrade timelines.

## [1.0.0] - 2025-04-30

### Added

- Initial release of Collaborative AI-DLC
- Three-phase lifecycle: Inception, Construction, Review
- Real-time collaboration with Yjs/CRDT
- Parallel agent construction with dependency-aware orchestration
- Graph-based traceability (requirements → stories → tasks → code)
- GitHub OAuth integration for repository management
- Cognito authentication with optional MFA
- Neptune graph database for project knowledge
- DynamoDB for operational state
- ECS-based agent workers
- WebSocket real-time notifications
- CloudFront + S3 frontend hosting
