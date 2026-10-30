import type { ToolArchitecture } from '@/services/environments';

// The Rust installer reads paths that embed the target triple, so the preset
// is a function of the architecture (mirrors rustInstaller(triple) in
// lambda/environments/tool-catalog.js).
export const RUST_TARGET_TRIPLES: Record<ToolArchitecture, string> = {
  arm64: 'aarch64-unknown-linux-gnu',
  x86_64: 'x86_64-unknown-linux-gnu',
};
export const rustInstallerScript = (architecture: ToolArchitecture) => {
  const triple = RUST_TARGET_TRIPLES[architecture];
  return `#!/usr/bin/env bash
set -Eeuo pipefail
staging="$TOOL_OUTPUT/.rust-installer"
archive_root="rust-\${TOOL_VERSION}-${triple}"
components="rustc,rust-std-${triple},cargo,rustfmt-preview"
mkdir -p "$staging"
trap 'rm -rf "$staging"' EXIT
tar -xzf "$TOOL_SOURCE" -C "$staging" \\
  "$archive_root/install.sh" \\
  "$archive_root/components" \\
  "$archive_root/rust-installer-version" \\
  "$archive_root/rustc" \\
  "$archive_root/rust-std-${triple}" \\
  "$archive_root/cargo" \\
  "$archive_root/rustfmt-preview"
installer="$staging/$archive_root/install.sh"
test -f "$installer"
"$installer" \\
  --prefix="$TOOL_OUTPUT" \\
  --disable-ldconfig \\
  --components="$components"
`;
};
