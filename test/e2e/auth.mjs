// test/e2e/auth.mjs
import pkg from 'amazon-cognito-identity-js';
const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

export function srpLogin({ userPoolId, userPoolClientId, username, password }) {
  const pool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: userPoolClientId });
  const user = new CognitoUser({ Username: username, Pool: pool });
  const details = new AuthenticationDetails({ Username: username, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (session) =>
        resolve({
          idToken: session.getIdToken().getJwtToken(),
          accessToken: session.getAccessToken().getJwtToken(),
          refreshToken: session.getRefreshToken().getToken(),
          sub: session.getIdToken().payload.sub,
        }),
      onFailure: (err) => reject(err),
      newPasswordRequired: () =>
        reject(
          new Error(
            'Cognito user requires a new password; set a permanent password before running.',
          ),
        ),
    });
  });
}
