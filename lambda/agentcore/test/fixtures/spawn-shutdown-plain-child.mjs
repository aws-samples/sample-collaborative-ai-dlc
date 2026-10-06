// The non-persona child for the CLI shutdown test: it just stays alive, so the
// runner is still mid-run when the signal arrives.
setInterval(() => {}, 1000);
