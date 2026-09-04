export const supportsCompatibilityVersion = (candidate, current) => {
  const candidateVersion = Number(candidate);
  const currentVersion = Number(current);
  return (
    Number.isInteger(candidateVersion) &&
    Number.isInteger(currentVersion) &&
    candidateVersion >= currentVersion - 1 &&
    candidateVersion <= currentVersion
  );
};

export default { supportsCompatibilityVersion };
