// Space-wide access. Membership is the authority: business roles and
// platform-admin claims are deliberately absent, so neither can turn a Viewer
// into a writer. Validated against space.cedarschema in the shared tests.

permit (principal, action == Action::"read", resource)
when { ["owner", "member", "viewer"].contains(principal.membershipRole) };

permit (principal, action == Action::"write", resource)
when { ["owner", "member"].contains(principal.membershipRole) };

permit (principal, action == Action::"manage", resource)
when { principal.membershipRole == "owner" };

forbid (principal, action, resource)
when { principal.membershipRole == "viewer" && action != Action::"read" };
