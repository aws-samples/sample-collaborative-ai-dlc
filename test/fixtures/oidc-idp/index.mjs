export const handler = async (event) => {
  const groups = event.request?.groupConfiguration?.groupsToOverride || [];
  event.response = event.response || {};
  event.response.claimsOverrideDetails = {
    claimsToAddOrOverride: {
      aidlc_roles: JSON.stringify(groups),
    },
  };
  return event;
};
