// Binding keys hash the project and execution together. Retain one permanent
// presence marker per logical space, the scope used by the project cascade.
export const nativeSpaceRetentionKey = (projectId) => ({
  pk: `NATIVE_SPACE#${projectId}`,
  sk: 'RETAINED',
});

export const nativeSpaceInventoryKey = { pk: 'NATIVE_SPACE_INVENTORY', sk: 'BINDINGS_V1' };

export const isNativeSpaceInventoryReady = (item) =>
  item?.pk === nativeSpaceInventoryKey.pk &&
  item.sk === nativeSpaceInventoryKey.sk &&
  item.version === 1 &&
  Object.keys(item).length === 3;
