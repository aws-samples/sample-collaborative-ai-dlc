// Canonical origin of this deployment.
//
// VITE_APP_ORIGIN is baked in at build time from the Terraform
// `application_url` output. Its hostname is the custom domain when one is
// configured and the CloudFront domain otherwise. It is the same origin the
// backend uses to build the OAuth redirect URIs.
//
// window.location.origin is only a fallback for local development. It must not
// be the primary source: a deployment with a custom domain is still reachable
// on the CloudFront domain and on every alias, so an admin browsing via one of
// those would otherwise be shown callback URLs that do not match what the
// backend sends. OAuth providers reject mismatched callbacks at sign-in time.
export const appOrigin = (): string => import.meta.env.VITE_APP_ORIGIN || window.location.origin;

/** True when the page was loaded from a hostname other than the canonical one. */
export const isNonCanonicalOrigin = (): boolean => {
  const canonical = import.meta.env.VITE_APP_ORIGIN;
  return Boolean(canonical) && canonical !== window.location.origin;
};
