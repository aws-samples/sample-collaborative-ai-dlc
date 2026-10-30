// CodeBuild fleet per target architecture. The managed-environment and tool
// CodeBuild projects default to the arm64 fleet; x86_64 images build and run
// their checks natively on the x86 fleet through per-build overrides. Both the
// environment build (runtime-backends/instances.js) and the tool build
// (tools-index.js) use this, so a bump of the x86 image happens in one place.
export const X86_64_CODEBUILD_OVERRIDES = Object.freeze({
  environmentTypeOverride: 'LINUX_CONTAINER',
  imageOverride: 'aws/codebuild/amazonlinux-x86_64-standard:5.0',
});

export const codeBuildOverridesFor = (architecture) =>
  architecture === 'x86_64' ? { ...X86_64_CODEBUILD_OVERRIDES } : {};
