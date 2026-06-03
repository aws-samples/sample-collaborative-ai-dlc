// test/e2e/defaultAnswer.mjs
export function isPending(question) {
  return !question || !question.structuredAnswer;
}

export function buildDefaultAnswer(question) {
  const qs = Array.isArray(question?.questions) ? question.questions : [];
  return {
    answers: qs.map((q) => {
      const hasOptions = Array.isArray(q?.options) && q.options.length > 0;
      if (!hasOptions) {
        return { selectedOptions: [], freeText: 'Proceed with the recommended default.' };
      }
      return { selectedOptions: [0] };
    }),
  };
}
