// A hosted Postbox on AWS (designs/architecture/hosted.md, “The test deployment on AWS”): a load balancer that signs
// people in, one task of Postbox behind it, and the disk its data folder is on. infra/README.md draws it.
//
// It is five parts, each a construct you can use alone, and this one puts them together in one scope:
//
//   PostboxNetwork  the VPC, and who may reach whom           (lib/network.mjs)
//   PostboxData     the disk the data folder is on            (lib/data.mjs)
//   PostboxEdge     the load balancer, its name, the sign-in  (lib/edge.mjs)
//   PostboxServer   the one task, and the service around it   (lib/server.mjs)
//   PostboxAgentHost  the machine agents work on              (lib/agent-host.mjs)
//
// Put each in a stack of its own, as app.mjs does, and one that fails rolls back alone. They bring what they aren’t
// given and use what they are: a VPC, a name in a hosted zone or a certificate, and the identity provider a team
// already has. Who may sign in is Postbox’s own allow list, checked by Postbox on every request against a token the
// load balancer signed, so neither reaching the port nor being able to sign in at the provider admits anyone by
// itself. The network’s rules are required: only the load balancer reaches the port.

import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PostboxAgentHost } from './agent-host.mjs';
import { PostboxData } from './data.mjs';
import { PostboxEdge } from './edge.mjs';
import { PostboxNetwork } from './network.mjs';
import { PostboxServer } from './server.mjs';

/**
 * Who may sign in, by their subject at the provider. It is required and names someone: Postbox doesn’t start without
 * an allow list (#1733), and no made-up name stands in for one. `groups` is only for an OIDC provider whose
 * administrators alone set the claim: a Cognito user pool’s userinfo carries a person’s attributes, which other
 * clients of the pool may let them write, so it is refused there.
 * @typedef {{ subjects?: string[], groups?: { claim: string, any: string[] } }} Allow
 */

/**
 * Postbox’s hosted settings, as its settings file holds them (server/hosted-settings.mjs): what it checks each
 * request’s token against, and who may sign in. Nothing in it is a secret or says who anyone is.
 * @param {Construct} scope
 * @param {{ edge: PostboxEdge, signIn?: import('./sign-in.mjs').SignIn, claims?: { username: string, name: string }, allow: Allow }} props
 *   claims: the claims that hold a person’s user name and name; `email` and `name`
 */
export function hostedSettings(scope, { edge, signIn, claims = { username: 'email', name: 'name' }, allow }) {
  if (allow?.groups && !(signIn && 'oidc' in signIn))
    throw new Error(
      'A Cognito user pool can’t back “allow.groups”: its userinfo carries attributes a person may be able to write. Name people by “allow.subjects”.',
    );
  if (allow?.groups && !(allow.groups.claim && allow.groups.any?.length)) throw new Error('“allow.groups” needs both the claim to read and the groups in it.');
  if (!allow?.subjects?.length && !allow?.groups)
    throw new Error(
      'A hosted Postbox needs “allow”: who may sign in, by their subject at the provider. Deploy the edge first if the provider is new, make a person there, and name them.',
    );
  const admitted = { ...(allow.subjects?.length ? { subjects: allow.subjects } : {}), ...(allow.groups ? { groups: allow.groups } : {}) };
  return { origin: edge.origin, signIn: { provider: 'alb', region: Stack.of(scope).region, ...edge.signedBy, claims, allow: admitted } };
}

/**
 * @typedef {object} HostedPostboxProps
 * @property {{ root: string, commit?: string }} source  the clone the image is built from, and its commit for the build line
 * @property {import('./address.mjs').Address} address  the name people open and its certificate
 * @property {import('./sign-in.mjs').SignIn} [signIn]  the identity provider to use; left out, a new Cognito user pool
 * @property {{ username: string, name: string }} [claims]
 * @property {Allow} allow
 * @property {import('aws-cdk-lib/aws-ec2').IVpc} [vpc]  one with private subnets that reach the internet; left out, a new one
 * @property {string} [openTo]  the addresses that reach the listener, as a CIDR; everywhere
 * @property {import('aws-cdk-lib').Duration} [sessionTimeout]  how long a sign-in at the load balancer lasts; 12 hours
 * @property {boolean} [deletionProtection]  whether the load balancer refuses to be deleted; true
 * @property {false | Partial<import('./agent-host.mjs').PostboxAgentHostProps>} [agentHost]  the machine agents work
 *   on, and what to change of it; false leaves it out, for hosts of your own added in Settings › Hosts
 */

export class HostedPostbox extends Construct {
  /** @param {Construct} scope @param {string} id @param {HostedPostboxProps} props */
  constructor(scope, id, props) {
    super(scope, id);
    const { signIn, sessionTimeout, deletionProtection } = props;
    this.network = new PostboxNetwork(this, 'Network', props);
    const { vpc, balancerGroup, serverGroup, diskGroup, hostGroup } = this.network;
    this.data = new PostboxData(this, 'Data', { vpc, diskGroup });
    this.edge = new PostboxEdge(this, 'Edge', { vpc, balancerGroup, address: props.address, signIn, sessionTimeout, deletionProtection });
    const hosted = hostedSettings(this, { ...props, edge: this.edge });
    const parameters = `/postbox/${this.node.addr}`;
    this.host = props.agentHost === false ? undefined : new PostboxAgentHost(this, 'Host', { parameters, ...props.agentHost, vpc, hostGroup });
    const { targets } = this.edge;
    this.server = new PostboxServer(this, 'Server', { vpc, serverGroup, ...this.data, targets, source: props.source, hosted, host: this.host });
    this.origin = this.edge.origin;
  }
}
