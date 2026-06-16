'use strict';

// The shipped baseline block library, owned by the SYSTEM tenant and read-only
// to everyone else. The seed lambda writes these into the blocks table + the
// artifacts bucket.
//
// This file is the data seam: growing the baseline means appending entries
// here — no code change to the seed lambda. It ships today with a deliberately
// minimal set (one of each common type, plus one skill wired to them) to prove
// the shape end-to-end; the full AI-DLC baseline (the complete skill/agent/
// scope/grouping set) lands later by extending this array.
//
// Each entry:
//   { type, id, name, body?, ...attrs }
// `type` is a block type (see shared/blocks.js BLOCK_TYPES); `id` is kebab-case;
// `body`, when present, is stored in S3 and replaced by a content-addressed
// pointer. Everything else is persisted verbatim as block attributes.

const BASELINE_BLOCKS = [
  // ── Groupings (organizing labels; the AI-DLC phases) ──
  {
    type: 'GROUPING',
    id: 'ideation',
    name: 'Ideation',
    kind: 'phase',
    description: 'Intent, research, scope, approval.',
  },
  {
    type: 'GROUPING',
    id: 'construction',
    name: 'Construction',
    kind: 'phase',
    description: 'Design, build, and verify the solution.',
  },

  // ── Agent (a persona that runs skills) ──
  {
    type: 'AGENT',
    id: 'product-agent',
    name: 'Product Agent',
    description: 'Owns intent capture and scope definition.',
    body: '# Product Agent\n\nResponsible for turning an ambiguous intent into a clear, bounded scope.\n',
  },

  // ── Scope (a reusable EXECUTE/SKIP preset) ──
  {
    type: 'SCOPE',
    id: 'mvp',
    name: 'MVP',
    depth: 'Standard',
    keywords: ['mvp', 'minimum viable'],
    description: 'Skip operations, ship the core.',
    body: '# MVP scope\n\nExecute the core path; skip operational hardening until later.\n',
  },

  // ── Skill (the atomic three-compartment unit) ──
  {
    type: 'SKILL',
    id: 'scope-definition',
    name: 'Scope Definition',
    defaultGrouping: 'ideation',
    leadAgent: 'product-agent',
    mode: 'inline',
    execution: 'ALWAYS',
    c1_definition: {
      purpose: 'Define the scope boundary and backlog for the intent.',
      inputs: [{ artifact: 'intent-statement', required: true }],
      outputs: ['scope-document'],
      intermediates: [],
      requires: [],
    },
    c2_verification: {
      postConditions: [],
      humanValidation: 'conditional',
    },
    body: '# Scope Definition\n\nProduce a scope document that bounds the intent and lists the backlog.\n',
  },
];

// The shipped baseline workflows, owned by the SYSTEM tenant and read-only to
// everyone else. A workflow references the baseline blocks above — it does not
// copy them. This is the "from default" fork source: a tenant clones it to get
// an editable composition. Like BASELINE_BLOCKS, this is a data seam — grow the
// default flow (or add more shipped workflows) by editing here.
//
// Each entry:
//   { id, name, objective?, groupings: [{ groupingId, path, kind }],
//     placements: [{ skillId, groupingPath, order, scopeMembership? }] }
// `path` encodes order + nesting (01, 01.02); placements reference library
// skills by id and home under a grouping path.

const BASELINE_WORKFLOWS = [
  {
    id: 'aidlc-v2',
    name: 'AI-DLC v2 (default)',
    objective: 'The default AI-DLC v2 flow — a starting point to fork and tailor.',
    groupings: [
      { groupingId: 'ideation', path: '01', kind: 'phase' },
      { groupingId: 'construction', path: '02', kind: 'phase' },
    ],
    placements: [{ skillId: 'scope-definition', groupingPath: '01', order: 1 }],
  },
];

module.exports = { BASELINE_BLOCKS, BASELINE_WORKFLOWS };
