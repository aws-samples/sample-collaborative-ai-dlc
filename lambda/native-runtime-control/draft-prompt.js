// Saved pre-Start content is separate from the immutable creation request.
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
export const promptFailure = (suffix) => {
  throw Object.assign(new Error('Native prompt command could not be completed'), {
    code: `NATIVE_PROMPT_${suffix}`,
  });
};
const validText = (value) =>
  typeof value === 'string' &&
  Boolean(value.trim()) &&
  Buffer.byteLength(value) <= 65536 &&
  !value.includes('\0') &&
  Buffer.from(value, 'utf8').toString('utf8') === value;

export const nativePromptRequest = (value) => {
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.requestId ?? '',
    ) ||
    !revision(value.expectedRevision) ||
    value.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    !validText(value.prompt)
  )
    promptFailure('INVALID');
  return {
    requestId: value.requestId,
    expectedRevision: value.expectedRevision,
    prompt: value.prompt,
  };
};

export const nativeDraftPrompt = (draft) => {
  if (draft.promptDraft === undefined) return { text: draft.request.prompt, revision: 0 };
  const value = draft.promptDraft;
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    !revision(value.revision) ||
    value.revision === 0 ||
    !validText(value.text)
  )
    promptFailure('INVALID');
  return { text: value.text, revision: value.revision };
};
