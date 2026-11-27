// Who signs people in at the load balancer (designs/architecture/hosted.md, “Who is asking”): the identity provider
// a team already has, or a new one. Signing in there says who a person is. Whether they may use this Postbox is
// Postbox’s allow list, so a provider shared with other applications admits none of their people by itself.

import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import { OAuthScope, UserPool, UserPoolClientIdentityProvider } from 'aws-cdk-lib/aws-cognito';
import { ListenerAction, UnauthenticatedAction } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { AuthenticateCognitoAction } from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';

/**
 * One of three:
 * - a Cognito user pool you have, with its sign-in domain: this adds one app client to it, for this load balancer;
 * - any OIDC provider, with a client you made there whose callback is `<origin>/oauth2/idpresponse`; its secret is
 *   read from Secrets Manager as the stack deploys, and is never in this code or its context;
 * - left out: a new user pool, whose people an administrator makes. Nobody signs themselves up.
 * @typedef {{ userPool: import('aws-cdk-lib/aws-cognito').IUserPool, userPoolDomain: import('aws-cdk-lib/aws-cognito').IUserPoolDomain }
 *          | { oidc: { issuer: string, authorizationEndpoint: string, tokenEndpoint: string, userInfoEndpoint: string,
 *                      clientId: string, clientSecret: import('aws-cdk-lib').SecretValue } }
 *          | undefined} SignIn
 */

const SCOPES = [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE];

/** A new pool: people by their email address, made by an administrator, with a name. @param {import('constructs').Construct} scope */
function newPool(scope) {
  const userPool = new UserPool(scope, 'People', {
    selfSignUpEnabled: false,
    signInAliases: { email: true },
    standardAttributes: { fullname: { required: true, mutable: true } },
    removalPolicy: RemovalPolicy.RETAIN,
  });
  // A sign-in page’s prefix is one name for all of AWS, so it carries this stack’s own id.
  const stackId = Stack.of(scope).stackId.split('/')[2] ?? Stack.of(scope).stackId;
  return { userPool, userPoolDomain: userPool.addDomain('SignInPage', { cognitoDomain: { domainPrefix: `postbox-${stackId}` } }) };
}

/**
 * @param {import('constructs').Construct} scope @param {SignIn} signIn
 * @param {{ origin: string, sessionTimeout: import('aws-cdk-lib').Duration }} at
 * @returns {{ clientId: string, issuer: string, action: (next: ListenerAction) => ListenerAction }}
 *   clientId and issuer: what the load balancer writes in each token’s header, which Postbox holds every token to
 */
export function signInOf(scope, signIn, { origin, sessionTimeout }) {
  if (signIn && 'oidc' in signIn) {
    const { issuer, clientId } = signIn.oidc;
    const action = (/** @type {ListenerAction} */ next) =>
      ListenerAction.authenticateOidc({
        ...signIn.oidc,
        scope: 'openid email profile',
        sessionTimeout,
        onUnauthenticatedRequest: UnauthenticatedAction.AUTHENTICATE,
        next,
      });
    return { clientId, issuer, action };
  }
  const { userPool, userPoolDomain } = signIn ?? newPool(scope);
  // A client of this load balancer’s own, so its secret and its callback are no other application’s.
  const client = userPool.addClient('BalancerClient', {
    generateSecret: true,
    supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
    oAuth: { flows: { authorizationCodeGrant: true }, scopes: SCOPES, callbackUrls: [`${origin}/oauth2/idpresponse`] },
    preventUserExistenceErrors: true,
  });
  return {
    clientId: client.userPoolClientId,
    issuer: `https://cognito-idp.${Stack.of(scope).region}.amazonaws.com/${userPool.userPoolId}`,
    action: (next) => new AuthenticateCognitoAction({ userPool, userPoolClient: client, userPoolDomain, sessionTimeout, next }),
  };
}
