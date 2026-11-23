export const validateYjsScope = (type, id) => {
  if (
    !['intent', 'project', 'sprint'].includes(type) ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error('Invalid Yjs scope');
  return `${type}:${id.toLowerCase()}`;
};

export const yjsScopeMarkerKey = (type, id) => ({
  documentId: `scope#${type}:${id.toLowerCase()}`,
});
