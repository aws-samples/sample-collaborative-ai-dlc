// The non-persona child for the CLI shutdown test: it stays alive, so the runner
// is still mid-run when the signal arrives. A non-persona child is not in the
// runner's process group, so the runner's death does not reach it; it exits on
// its own once its parent is gone rather than outliving the test run.
const parent = process.ppid;
const parentAlive = () => {
  try {
    process.kill(parent, 0);
    return true;
  } catch {
    return false;
  }
};
setInterval(() => {
  if (!parentAlive()) process.exit(0);
}, 200);
