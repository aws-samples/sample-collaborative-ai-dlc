import { expect } from 'vitest';

// Execute the small Gremlin subset used by the real projector. State changes
// follow the actual coalesce branches and deterministic IDs so replay tests
// would detect duplicate nodes/edges, not merely count method invocations.
export const memoryGraph = () => {
  const vertices = new Map();
  const edges = new Map();
  const writes = [];
  const hooks = {};
  const steps = (traversal) => traversal.getBytecode().stepInstructions;
  const predicate = (instructions, vertex) => {
    if (instructions[0]?.[0] === 'properties') {
      expect(instructions.map((step) => step[0])).toEqual(['properties', 'count', 'is']);
      const key = instructions[0][1];
      const value = vertex.properties[key];
      const count = !Object.hasOwn(vertex.properties, key)
        ? 0
        : Array.isArray(value)
          ? value.length
          : 1;
      return count === instructions[2][1];
    }
    if (instructions[0]?.[0] === 'V')
      return predicate(instructions.slice(1), vertices.get(instructions[0][1]));
    return instructions.every(([name, ...args]) => {
      if (name === 'or') return args.some((arg) => predicate(steps(arg), vertex));
      if (name === 'inV') return true;
      if (name === 'hasLabel') return args.includes(vertex.label);
      if (name === 'has') {
        if (args.length === 1) return Object.hasOwn(vertex.properties, args[0]);
        const value = vertex.properties[args[0]];
        if (args[1]?.operator === 'lte') return value <= args[1].value;
        return Array.isArray(value) ? value.includes(args[1]) : value === args[1];
      }
      if (name === 'filter') return predicate(steps(args[0]), vertex);
      if (name === 'not') return !predicate(steps(args[0]), vertex);
      throw new Error(`Unsupported graph predicate: ${name}`);
    });
  };
  const query = (kind, id) => {
    const properties = [];
    const filters = [];
    let returnId = false;
    let alternatives;
    let selectedEdges;
    let removing = false;
    const edgeFilters = [];
    let outLabel;
    let parentFilters = [];
    const q = {
      fold: () => q,
      coalesce: (...branches) => {
        alternatives = branches;
        return q;
      },
      hasLabel: (label) => {
        filters.push((vertex) => vertex.label === label);
        return q;
      },
      has: (key, value) => {
        filters.push((vertex) => {
          const current = vertex.properties[key];
          return Array.isArray(current) ? current.includes(value) : current === value;
        });
        return q;
      },
      filter: (traversal) => {
        (selectedEdges ? edgeFilters : filters).push((vertex) =>
          predicate(steps(traversal), vertex),
        );
        return q;
      },
      outE: (...labels) => {
        selectedEdges = labels;
        return q;
      },
      out: (label) => {
        outLabel = label;
        parentFilters = filters.splice(0);
        return q;
      },
      drop: () => {
        removing = true;
        return q;
      },
      iterate: async () => {
        await q.next();
      },
      toList: async () => {
        const result = await q.next();
        return result.done ? [] : [result.value];
      },
      property: (...args) => {
        properties.push(args.slice(-2));
        return q;
      },
      id: () => {
        returnId = true;
        return q;
      },
      next: async () => {
        await hooks.before?.({ kind, id, properties, alternatives });
        if (kind === 'E' && !filters.every((filter) => filter(null)))
          return { done: true, value: null };
        if (alternatives) {
          const insert = steps(alternatives[1]);
          if (kind === 'V' && !vertices.has(id)) {
            const label = insert.find((step) => step[0] === 'addV')?.[1];
            const physicalId = insert.find((step) => step[0] === 'property')?.at(-1);
            expect(physicalId).toBe(id);
            const initial = Object.fromEntries(
              insert
                .filter((step) => step[0] === 'property' && typeof step.at(-2) === 'string')
                .map((step) => step.slice(-2)),
            );
            vertices.set(id, { id, label, properties: initial });
            writes.push({ kind: 'vertex', id });
          }
          if (kind === 'E' && !edges.has(id)) {
            const from = insert.find((step) => step[0] === 'V')?.[1];
            const label = insert.find((step) => step[0] === 'addE')?.[1];
            const toTraversal = insert.find((step) => step[0] === 'to')?.[1];
            const to = steps(toTraversal).find((step) => step[0] === 'V')?.[1];
            const physicalId = insert.find((step) => step[0] === 'property')?.at(-1);
            expect(physicalId).toBe(id);
            expect(vertices.has(from)).toBe(true);
            expect(vertices.has(to)).toBe(true);
            edges.set(id, { id, source: from, target: to, label });
            writes.push({ kind: 'edge', id });
          }
        }
        if (
          kind === 'V' &&
          !(outLabel ? parentFilters : filters).every((filter) => filter(vertices.get(id)))
        ) {
          return { done: true, value: null };
        }
        if (removing) {
          const sources = outLabel
            ? [...edges.values()]
                .filter((edge) => edge.source === id && edge.label === outLabel)
                .map((edge) => edge.target)
                .filter((target) => filters.every((filter) => filter(vertices.get(target))))
            : [id];
          for (const [edgeId, edge] of edges) {
            if (
              sources.includes(edge.source) &&
              selectedEdges.includes(edge.label) &&
              edgeFilters.every((filter) => filter(vertices.get(edge.target)))
            ) {
              edges.delete(edgeId);
              writes.push({ kind: 'edge-drop', id: edgeId });
            }
          }
          return { done: true, value: null };
        }
        if (properties.length) {
          expect(kind).toBe('V');
          const vertex = vertices.get(id);
          expect(vertex).toBeDefined();
          for (const [key, value] of properties) vertex.properties[key] = value;
          writes.push({ kind: 'properties', id });
        }
        await hooks.after?.({ kind, id, properties, alternatives });
        return {
          done: false,
          value: returnId ? id : kind === 'V' ? vertices.get(id) : edges.get(id),
        };
      },
    };
    return q;
  };
  return {
    vertices,
    edges,
    writes,
    hooks,
    g: { V: (id) => query('V', id), E: (id) => query('E', id) },
  };
};
