// Runs at most `limit` workers concurrently while preserving input order in
// the returned results. A worker rejection fails the whole operation.
const mapWithConcurrency = async (items, limit, worker) => {
  const results = Array.from({ length: items.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

export { mapWithConcurrency };
