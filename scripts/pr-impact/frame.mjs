const ID = /^[a-z][a-z0-9-]{0,63}$/;
const text = (value, max) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{C}]/u.test(value);

function check(condition, message) {
  if (!condition) throw new Error(`Invalid fixed map: ${message}`);
}

function rules(paths) {
  check(Array.isArray(paths), 'path rules must be an array');
  for (const path of paths) {
    check(text(path, 300) && !path.startsWith('/') && !path.includes('..'), 'relative path rule');
    check(!path.slice(0, -1).includes('*'), 'only a trailing prefix wildcard is supported');
  }
  return paths;
}

function match(path, rule) {
  if (rule.endsWith('*')) return path.startsWith(rule.slice(0, -1));
  return path === rule || (rule.endsWith('/') && path.startsWith(rule));
}

function bestMatch(path, entries) {
  return entries
    .flatMap((entry) => entry.paths.map((rule) => ({ entry, rule })))
    .filter(({ rule }) => match(path, rule))
    .toSorted((a, b) => b.rule.replace(/\*$/, '').length - a.rule.replace(/\*$/, '').length)[0]
    ?.entry;
}

// This authored hierarchy owns classification. Imports never retarget a file's
// box, and Isobar's 21-region sanitation limit never truncates the finer frame.
export function loadFrame(source) {
  check(source?.version === 1, 'version');
  check(
    Array.isArray(source.layers) && source.layers.length > 0 && source.layers.length <= 6,
    'bands',
  );
  check(
    Array.isArray(source.regions) && source.regions.length > 0 && source.regions.length <= 20,
    'sections',
  );
  const used = new Set();
  const layers = source.layers.map((layer) => {
    check(ID.test(layer.id) && !used.has(layer.id), 'unique band ID');
    used.add(layer.id);
    check(text(layer.name, 48), 'band name');
    check(text(layer.blurb, 80), 'band description');
    check(
      Number.isInteger(layer.height) && layer.height >= 240 && layer.height <= 800,
      'band height',
    );
    return { ...layer };
  });
  const layerIds = new Set(layers.map(({ id }) => id));
  const sections = source.regions.map((section) => {
    check(ID.test(section.id) && !used.has(section.id), 'unique section ID');
    used.add(section.id);
    check(text(section.name, 24) && text(section.blurb, 48), 'section name and description');
    check(layerIds.has(section.layer), 'section band');
    check(
      Number.isInteger(section.width) && section.width >= 350 && section.width <= 1200,
      'section width',
    );
    check(
      Number.isInteger(section.columns) && section.columns >= 1 && section.columns <= 3,
      'child columns',
    );
    check(
      Array.isArray(section.children) &&
        section.children.length >= 1 &&
        section.children.length <= 8,
      'children',
    );
    const children = section.children.map((child) => {
      check(ID.test(child.id), 'child ID');
      const id = `${section.id}-${child.id}`;
      check(!used.has(id), 'unique child ID');
      used.add(id);
      check(text(child.name, 24) && text(child.blurb, 48), 'child name and description');
      check(child.fallback === undefined || typeof child.fallback === 'boolean', 'fallback marker');
      return {
        ...child,
        id,
        sectionId: section.id,
        layer: section.layer,
        paths: rules(child.paths),
      };
    });
    check(
      children.filter(({ fallback }) => fallback === true).length === 1,
      'one fallback child per section',
    );
    return { ...section, paths: rules(section.paths), children };
  });
  check(
    sections.every((section) => layers.some(({ id }) => id === section.layer)),
    'section membership',
  );
  check(
    layers.every((layer) => sections.some(({ layer: id }) => id === layer.id)),
    'nonempty bands',
  );
  const leaves = sections.flatMap(({ children }) => children);
  check(leaves.length <= 80, 'at most 80 children');
  const fallbackSection = sections.find(({ id }) => id === source.fallbackSection);
  check(fallbackSection, 'fallback section');
  const assign = (path) => {
    const section = bestMatch(path, sections) ?? fallbackSection;
    const leaf =
      bestMatch(path, section.children) ?? section.children.find(({ fallback }) => fallback);
    return { section, leaf };
  };
  const legend = sections.map((section) => ({
    id: section.id,
    name: section.name,
    description: section.blurb,
    layer: layers.find(({ id }) => id === section.layer).name,
    children: section.children.map((child) => ({
      id: child.id,
      name: child.name,
      description: child.blurb,
    })),
  }));
  return { source, layers, sections, leaves, assign, legend };
}

export function analysisMap(frame, files) {
  const owned = new Map(frame.leaves.map(({ id }) => [id, []]));
  for (const path of new Set(files)) owned.get(frame.assign(path).leaf.id).push(path);
  return {
    ...frame.source,
    layers: frame.layers,
    regions: frame.leaves.map((leaf) => ({ ...leaf, weight: 1, paths: owned.get(leaf.id) })),
  };
}

// A continuous atlas: every leaf tiles its parent, and every parent tiles its
// band. Titles overlay the geography; no header rows, padding or card gutters.
export function frameLayout(frame) {
  const width = 2400;
  const margin = 12;
  const panels = [];
  const bands = [];
  let y = 52;
  for (const layer of frame.layers) {
    const sections = frame.sections.filter((section) => section.layer === layer.id);
    bands.push({ name: layer.name, description: layer.blurb, x: margin, y });
    const available = width - 2 * margin;
    const total = sections.reduce((sum, section) => sum + section.width, 0);
    let x = margin;
    for (const [index, section] of sections.entries()) {
      const w =
        index === sections.length - 1
          ? width - margin - x
          : Math.round((section.width / total) * available);
      const rect = { x, y, w, h: layer.height };
      const inside = { ...rect };
      const rows = Math.ceil(section.children.length / section.columns);
      const rowHeight = Math.floor(inside.h / rows);
      const children = [];
      for (let row = 0; row < rows; row++) {
        const items = section.children.slice(row * section.columns, (row + 1) * section.columns);
        const cellWidth = Math.floor(inside.w / items.length);
        for (const [column, leaf] of items.entries()) {
          const cx = inside.x + column * cellWidth;
          children.push({
            ...leaf,
            rect: {
              x: cx,
              y: inside.y + row * rowHeight,
              w: column === items.length - 1 ? inside.x + inside.w - cx : cellWidth,
              h: row === rows - 1 ? inside.y + inside.h - (inside.y + row * rowHeight) : rowHeight,
            },
          });
        }
      }
      panels.push({ ...section, rect, children });
      x += w;
    }
    y += layer.height;
  }
  return {
    width,
    height: y + 52,
    bands,
    panels,
    mapRect: { x: margin, y: 52, w: width - 2 * margin, h: y - 52 },
  };
}

export async function nestedPicture({
  frame,
  facts,
  weather,
  map,
  layoutOf,
  fieldOf,
  inks,
  anchors,
  evidence,
}) {
  const layout = frameLayout(frame);
  // Blob radius and final pixel grain are independent: larger visible hotspots,
  // still sampled to fine 4 px cells by the PNG renderer.
  const sample = 7;
  for (const panel of layout.panels) {
    for (const leaf of panel.children) {
      const region = map.regions.find(({ id }) => id === leaf.id);
      const cells = weather.cells.filter(({ region: owner }) => owner === leaf.id);
      const reach = evidence.reachByCause.filter(
        (r) =>
          frame.assign(r.path).leaf.id === leaf.id &&
          !r.isChanged &&
          r.evidence !== 'transit-import',
      );
      leaf.changed = cells.length;
      leaf.reached = new Set(reach.map(({ path }) => path)).size;
      // The ownership rectangle is all field. Thin boundaries and glyph halos
      // are drawn afterward; they never become padded miniature pictures.
      leaf.body = { ...leaf.rect };
      check(leaf.body.h >= 24, `label space for ${leaf.name}`);
      if (!cells.length && !reach.length) continue;
      const local = layoutOf(
        { ...map, layers: [{ id: region.layer, name: '', blurb: '' }], regions: [region] },
        region.paths,
        facts.lines,
        Math.floor(leaf.body.w / sample),
        Math.max(2, Math.floor(leaf.body.h / (2 * sample))),
      );
      local.points = new Map(
        region.paths.map((path) => {
          const p = anchors.get(path);
          return [path, { x: p.x * local.cols, y: p.y * local.rows * 2 }];
        }),
      );
      const w = local.cols,
        h = local.rows * 2;
      const level = new Uint8Array(w * h),
        wet = new Uint8Array(w * h);
      for (const cell of cells) {
        const change = evidence.changes.find(({ path }) => path === cell.path);
        const production = ['source', 'runtime-input', 'infrastructure'].includes(change.role);
        const shape = fieldOf(
          local,
          {
            ...weather,
            // The upstream drawing primitive uses a field named "risk".
            // A constant makes this solely a change-location marker.
            cells: [{ ...cell, risk: production ? 0.5 : 0.15, isLatest: true }],
            reach: [],
            arms: [],
            offshoots: [],
            expected: [],
          },
          { code: false, impact: false, risk: true, history: false },
          `Collaborative AI-DLC:${cell.path}`,
        );
        const shapePeak = Math.max(1, ...shape.level);
        // Deemphasize test/docs markers without assigning a risk grade.
        const peak = production ? 11 : 4;
        for (let i = 0; i < level.length; i++) {
          level[i] = Math.max(level[i], Math.round((shape.level[i] / shapePeak) * peak));
        }
      }
      // Render fallback as dotted rain; never turn unknown uses into a match.
      // Deduplicate only for painting. All causes stay intact in the report.
      const painted = new Map();
      for (const row of reach) {
        const prior = painted.get(row.path);
        if (!prior || row.evidence === 'name-match') painted.set(row.path, row);
      }
      for (const row of painted.values()) {
        const p = anchors.get(row.path);
        const cx = p.x * w,
          cy = p.y * h;
        const radius = row.evidence === 'name-match' ? 4 : 3;
        for (
          let y = Math.max(0, Math.floor(cy - radius * 3));
          y < Math.min(h, cy + radius * 3);
          y++
        ) {
          for (
            let x = Math.max(0, Math.floor(cx - radius * 3));
            x < Math.min(w, cx + radius * 3);
            x++
          ) {
            if (row.evidence === 'import-fallback' && (x + y) % 3 !== 0) continue;
            const v = Math.round(
              (row.targetRole === 'test' ? 3 : 8) *
                Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * radius ** 2)),
            );
            const i = y * w + x;
            if (v > level[i] && (level[i] === 0 || wet[i])) {
              level[i] = v;
              wet[i] = 1;
            }
          }
        }
      }
      leaf.heat = { w, h, level: [...level], wet: [...wet] };
      leaf.markers = evidence.changes
        .filter((c) => c.leafId === leaf.id)
        .map((c) => ({
          path: c.path,
          x: leaf.body.x + c.anchor.x * leaf.body.w,
          y: leaf.body.y + c.anchor.y * leaf.body.h,
          status: c.status,
          role: c.role,
          key: evidence.annotations.find((a) => a.path === c.path)?.key,
        }));
    }
  }
  return {
    ...layout,
    palette: { paper: inks.paper, radar: inks.radar, rain: inks.rain },
  };
}
