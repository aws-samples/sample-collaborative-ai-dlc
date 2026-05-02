# Export

AIDLC Collaborative supports exporting specs in several formats for sharing outside the platform.

## Markdown export

Export the full spec as a single Markdown file. This includes all documents merged into one file with proper headings.

Access it from the spec editor toolbar via the **Export** dropdown.

!!! info "NEED IMAGE HERE"
    Screenshot of the Export dropdown in the spec editor toolbar showing the available export options.

## ZIP export

Export all spec documents as a ZIP archive. Each document is saved as a separate Markdown file, preserving the original file tree structure.

## API export

You can also export programmatically via the API:

```text
GET /api/specs/{id}/export
```

This returns the rendered Markdown content of the spec.

## What is included

The export includes:

- All spec documents with their content
- Document metadata (paths, creation dates)

The export does not include:

- Chat history
- Comments and replies
- Version history
- Decompose tasks
