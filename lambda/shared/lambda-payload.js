// Decode a Lambda InvokeCommand response payload (Uint8Array) into JSON.
const parseLambdaPayload = (payload) => {
  if (!payload) return null;
  const text = Buffer.from(payload).toString('utf8');
  return text ? JSON.parse(text) : null;
};

export { parseLambdaPayload };
export default { parseLambdaPayload };
