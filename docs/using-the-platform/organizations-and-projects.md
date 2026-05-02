# Organizations and Projects

AIDLC Collaborative uses a two-level hierarchy to organize work: organizations contain projects, and projects contain specs.

## Organizations

An organization is the top-level container. It represents a team, company, or group of people working together.

Each organization has:

- A unique URL slug (for example, `/my-team`)
- Members with roles (owner, admin, member)
- Projects
- Methodologies

### Creating an organization

Choose **New Organization** on the home page. Enter a name and URL slug.

!!! info "NEED IMAGE HERE"
    Screenshot of the home page with the organization list and New Organization button.

### Member roles

| Role | Can do |
|------|--------|
| **Owner** | Everything, including deleting the org and managing other owners |
| **Admin** | Manage members, create projects, manage settings |
| **Member** | Access projects they are assigned to |

## Projects

A project groups related specs together. It represents a product, service, or feature area.

Each project has:

- A unique slug within the organization
- Members with project-level roles
- Git repository connections
- Specs

### Creating a project

Navigate to your organization and choose **New Project**. Enter a name and slug.

!!! info "NEED IMAGE HERE"
    Screenshot of the organization page showing the project list and New Project button.

### Project roles

| Role | Can do |
|------|--------|
| **Admin** | Manage project members, settings, and repos |
| **Editor** | Create and edit specs, run decompose, start agents |
| **Viewer** | Read-only access to specs and tasks |

### Permission resolution

When a user accesses a project, their effective role is resolved in this order:

1. Check if the user has an explicit project role
2. If not, fall back to their org role (owner/admin become project admin, member gets no access)
3. If neither, access is denied

## Navigation

The URL structure mirrors the hierarchy:

```text
/{orgSlug}                          -- Organization page (project list)
/{orgSlug}/{projectSlug}            -- Project page (spec list)
/{orgSlug}/{projectSlug}/{specSlug} -- Spec editor
```
