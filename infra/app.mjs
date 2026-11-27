#!/usr/bin/env node
// A CDK app that deploys one hosted Postbox (infra/README.md), and an example of using the HostedPostbox construct
// in a stack of your own. What is yours comes in as context, from `-c name=value` or from `cdk.context.json` beside
// this file, which git ignores: your domain, your hosted zone, your identity provider and who may sign in are never
// in this file.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { App, SecretValue, Stack } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { UserPool, UserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { HostedPostbox } from './lib/hosted-postbox.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = new App();
const context = (/** @type {string} */ name) => app.node.tryGetContext(name);
const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : String(value ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);

/** The clone’s commit, for the build line in the sidebar; nothing when this isn’t a clone. */
function commit() {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return ''; // not a git checkout: the build line shows the version alone
  }
}

/** The address: a name in a hosted zone of yours, or a certificate of yours. @param {Stack} stack */
function address(stack) {
  const domainName = context('domainName');
  if (context('hostedZoneId'))
    return {
      domainName,
      hostedZone: HostedZone.fromHostedZoneAttributes(stack, 'Zone', { hostedZoneId: context('hostedZoneId'), zoneName: context('hostedZoneName') }),
    };
  if (!context('certificateArn'))
    throw new Error('Give the address: -c domainName= -c hostedZoneId= -c hostedZoneName=, or -c certificateArn= (infra/README.md).');
  return { domainName, certificate: Certificate.fromCertificateArn(stack, 'Certificate', context('certificateArn')) };
}

/** The identity provider: a user pool of yours, an OIDC provider of yours, or none, for a new pool. @param {Stack} stack */
function signIn(stack) {
  if (context('userPoolId'))
    return {
      userPool: UserPool.fromUserPoolId(stack, 'Pool', context('userPoolId')),
      userPoolDomain: UserPoolDomain.fromDomainName(stack, 'PoolDomain', context('userPoolDomain')),
    };
  if (!context('oidcIssuer')) return undefined;
  return {
    oidc: {
      issuer: context('oidcIssuer'),
      authorizationEndpoint: context('oidcAuthorizationEndpoint'),
      tokenEndpoint: context('oidcTokenEndpoint'),
      userInfoEndpoint: context('oidcUserInfoEndpoint'),
      clientId: context('oidcClientId'),
      clientSecret: SecretValue.secretsManager(context('oidcClientSecretName')),
    },
  };
}

const stack = new Stack(app, context('stackName') ?? 'PostboxTest', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
const groups = list(context('allowGroups'));
new HostedPostbox(stack, 'Postbox', {
  source: { root, commit: commit() },
  address: address(stack),
  signIn: signIn(stack),
  claims: { username: context('claimUsername') ?? 'email', name: context('claimName') ?? 'name' },
  allow: { subjects: list(context('allowSubjects')), groups: groups.length ? { claim: context('allowGroupsClaim'), any: groups } : undefined },
  openTo: context('openTo'),
  deletionProtection: context('deletionProtection') !== 'false' && context('deletionProtection') !== false,
});
