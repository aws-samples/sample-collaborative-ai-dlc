// Test-only evaluator for the DynamoDB condition expressions the run-fenced
// retirement writes use, over the MARSHALLED item (AttributeValue map), so a
// stored null (`{ NULL: true }`) is an existing attribute exactly as in
// DynamoDB. Supports AND/OR/parentheses, `path = :value`,
// attribute_exists/attribute_not_exists(path) and attribute_type(path, :type).
import { marshall } from '@aws-sdk/util-dynamodb';

const tokenize = (expression) => expression.match(/\(|\)|,|=|[#:A-Za-z_][\w.]*/g) ?? [];

const typeOf = (attribute) => Object.keys(attribute ?? {})[0] ?? null;

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const evaluateCondition = (expression, { item, values = {}, names = {} }) => {
  const tokens = tokenize(expression);
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected) => {
    const token = tokens[at++];
    if (expected && token !== expected) throw new Error(`expected ${expected}, got ${token}`);
    return token;
  };
  const path = () => {
    const token = take();
    return names[token] ?? token;
  };
  const value = () => {
    const token = take();
    if (!(token in values)) throw new Error(`unbound value ${token}`);
    return values[token];
  };
  const factor = () => {
    const token = peek();
    if (token === '(') {
      take('(');
      const result = or();
      take(')');
      return result;
    }
    if (token === 'attribute_exists' || token === 'attribute_not_exists') {
      take();
      take('(');
      const exists = Object.hasOwn(item ?? {}, path());
      take(')');
      return token === 'attribute_exists' ? exists : !exists;
    }
    if (token === 'attribute_type') {
      take();
      take('(');
      const attribute = (item ?? {})[path()];
      take(',');
      const expected = value();
      take(')');
      return attribute !== undefined && typeOf(attribute) === expected.S;
    }
    const left = (item ?? {})[path()];
    take('=');
    const right = value();
    return left !== undefined && sameValue(left, right);
  };
  const and = () => {
    let result = factor();
    while (peek() === 'AND') {
      take();
      result = factor() && result;
    }
    return result;
  };
  const or = () => {
    let result = and();
    while (peek() === 'OR') {
      take();
      result = and() || result;
    }
    return result;
  };
  const result = or();
  if (at !== tokens.length) throw new Error(`trailing tokens in ${expression}`);
  return result;
};

// A DocumentClient ConditionCheck evaluated against a DocumentClient item.
export const conditionCheckPasses = (check, plainItem) =>
  evaluateCondition(check.ConditionExpression, {
    item: plainItem
      ? marshall(plainItem, { removeUndefinedValues: true, convertClassInstanceToMap: true })
      : null,
    values: check.ExpressionAttributeValues
      ? marshall(check.ExpressionAttributeValues, { removeUndefinedValues: true })
      : {},
    names: check.ExpressionAttributeNames ?? {},
  });
