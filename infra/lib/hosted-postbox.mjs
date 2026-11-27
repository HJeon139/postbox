// A hosted Postbox on AWS (designs/architecture/hosted.md, “The test deployment on AWS”; infra/README.md):
//
//   Browser → ALB (TLS, sign-in) → one Fargate task (Postbox, port 8080) → EFS (the data folder)
//
// It is four parts, each a construct you can use alone, and this one puts them together in one scope:
//
//   PostboxNetwork  the VPC, and who may reach whom           (lib/network.mjs)
//   PostboxData     the disk the data folder is on            (lib/data.mjs)
//   PostboxEdge     the load balancer, its name, the sign-in  (lib/edge.mjs)
//   PostboxServer   the one task, and the service around it   (lib/server.mjs)
//
// Put each in a stack of its own, as app.mjs does, and one that fails rolls back alone. They bring what they aren’t
// given and use what they are: a VPC, a name in a hosted zone or a certificate, and the identity provider a team
// already has. Who may sign in is Postbox’s own allow list, checked by Postbox on every request against a token the
// load balancer signed, so neither reaching the port nor being able to sign in at the provider admits anyone by
// itself. The network’s rules are the second line.

import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PostboxData } from './data.mjs';
import { PostboxEdge } from './edge.mjs';
import { PostboxNetwork } from './network.mjs';
import { PostboxServer } from './server.mjs';

/**
 * Who may sign in, by their subject at the provider. Left out or empty, no one may: Postbox doesn’t start without an
 * allow list (#1733), so it is given one that names no one. `groups` is only for an OIDC provider whose
 * administrators alone set the claim: a Cognito user pool’s userinfo carries a person’s attributes, which other
 * clients of the pool may let them write, so it is refused there.
 * @typedef {{ subjects?: string[], groups?: { claim: string, any: string[] } }} Allow
 */

/**
 * Postbox’s hosted settings, as its settings file holds them (server/hosted-settings.mjs): what it checks each
 * request’s token against, and who may sign in. Nothing in it is a secret or says who anyone is.
 * @param {Construct} scope
 * @param {{ edge: PostboxEdge, signIn?: import('./sign-in.mjs').SignIn, claims?: { username: string, name: string }, allow?: Allow }} props
 *   claims: the claims that hold a person’s user name and name; `email` and `name`
 */
export function hostedSettings(scope, { edge, signIn, claims = { username: 'email', name: 'name' }, allow }) {
  if (allow?.groups && !(signIn && 'oidc' in signIn))
    throw new Error(
      'A Cognito user pool can’t back “allow.groups”: its userinfo carries attributes a person may be able to write. Name people by “allow.subjects”.',
    );
  const subjects = allow?.subjects?.length ? { subjects: allow.subjects } : {};
  const admitted = allow?.groups ? { ...subjects, groups: allow.groups } : { subjects: ['no-one-yet'], ...subjects };
  return { origin: edge.origin, signIn: { provider: 'alb', region: Stack.of(scope).region, ...edge.signedBy, claims, allow: admitted } };
}

/**
 * @typedef {object} HostedPostboxProps
 * @property {{ root: string, commit?: string }} source  the clone the image is built from, and its commit for the build line
 * @property {import('./address.mjs').Address} address  the name people open and its certificate
 * @property {import('./sign-in.mjs').SignIn} [signIn]  the identity provider to use; left out, a new Cognito user pool
 * @property {{ username: string, name: string }} [claims]
 * @property {Allow} [allow]
 * @property {import('aws-cdk-lib/aws-ec2').IVpc} [vpc]  one with private subnets that reach the internet; left out, a new one
 * @property {string} [openTo]  the addresses that reach the listener, as a CIDR; everywhere
 * @property {import('aws-cdk-lib').Duration} [sessionTimeout]  how long a sign-in at the load balancer lasts; 12 hours
 * @property {boolean} [deletionProtection]  whether the load balancer refuses to be deleted; true
 */

export class HostedPostbox extends Construct {
  /** @param {Construct} scope @param {string} id @param {HostedPostboxProps} props */
  constructor(scope, id, props) {
    super(scope, id);
    const { signIn, sessionTimeout, deletionProtection } = props;
    this.network = new PostboxNetwork(this, 'Network', props);
    const { vpc, balancerGroup, serverGroup, diskGroup } = this.network;
    this.data = new PostboxData(this, 'Data', { vpc, diskGroup });
    this.edge = new PostboxEdge(this, 'Edge', { vpc, balancerGroup, address: props.address, signIn, sessionTimeout, deletionProtection });
    const hosted = hostedSettings(this, { ...props, edge: this.edge });
    this.server = new PostboxServer(this, 'Server', { vpc, serverGroup, ...this.data, targets: this.edge.targets, source: props.source, hosted });
    this.origin = this.edge.origin;
  }
}
