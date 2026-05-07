import { CognitoJwtVerifier } from 'aws-jwt-verify';

let verifier;
const getVerifier = () => {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      tokenUse: 'id',
      clientId: process.env.COGNITO_CLIENT_ID
    });
  }
  return verifier;
};

export const handler = async (event) => {
  const token = event.queryStringParameters?.token;
  const methodArn = event.methodArn;

  if (!token) {
    console.log('No token provided');
    return generatePolicy('user', 'Deny', methodArn);
  }

  try {
    const payload = await getVerifier().verify(token);
    return generatePolicy(payload.sub, 'Allow', methodArn, {
      userId: payload.sub,
      userName: payload['cognito:username'] || payload.email || payload.sub
    });
  } catch (err) {
    console.error('Token verification failed:', err.message);
    return generatePolicy('user', 'Deny', methodArn);
  }
};

const generatePolicy = (principalId, effect, resource, context = {}) => ({
  principalId,
  policyDocument: {
    Version: '2012-10-17',
    Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }]
  },
  context
});
