// Doc-name extraction for WebSocket upgrade paths.
//
// In deployed environments the Yjs origin sits behind CloudFront's `/yjs/*`
// path behavior, which forwards the FULL path to the ALB (no origin-path
// rewrite) — so upgrades arrive as `/yjs/<docName>`. Local development
// connects to the server directly as `/<docName>`. The routing prefix is not
// part of the document identity, and the anchored scope patterns in
// `realtime-token.js` (deny-by-default) would otherwise reject every deployed
// doc with `unknown_scope`.
export const docNameFromPath = (pathname) => {
  if (typeof pathname !== 'string') return 'default';
  return pathname.replace(/^\/(?:yjs\/)?/, '') || 'default';
};
