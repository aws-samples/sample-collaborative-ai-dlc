# Organizations and Projects

AIDLC Collaborative uses a project based approach to work.

## Projects

A project groups related specs together. It represents a product, service, or feature area.

Each project has:

- A unique slug within the organization
- Members with project-level roles
- Git repository connections
- Specs

### Creating a project

Navigate to your organization and choose **New Project**. Enter a name and slug.

### Project roles

| Role | Can do |
|------|--------|
| **Admin** | Manage project members, settings, and repos |
| **Editor** | Create and edit specs, run inception, start agents |
| **Viewer** | Read-only access to specs and tasks |

### Permission resolution

When a user accesses a project, their effective role is resolved in this order:

1. Check if the user has an explicit project role
2. If not, fall back to their org role (owner/admin become project admin, member gets no access)
3. If neither, access is denied