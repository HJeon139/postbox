// The network of a hosted Postbox, and who may reach whom in it (designs/architecture/hosted.md, “The test deployment
// on AWS”). The rules are the second line: Postbox checks the load balancer’s signed token on every request whatever
// reaches it (“Who is asking”). They live together here, apart from what they protect, so that a server that fails to
// start never takes the network down with it, and so that no part needs another’s security group to exist first.

import { Peer, Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/** The port Postbox listens on in its container. */
export const PORT = 8080;

export class PostboxNetwork extends Construct {
  /**
   * @param {Construct} scope @param {string} id
   * @param {{ vpc?: import('aws-cdk-lib/aws-ec2').IVpc, openTo?: string }} [props]
   *   vpc: one of yours, with private subnets that reach the internet; left out, a new one, with the load balancer in
   *   its public subnets and Postbox in its private ones behind one NAT gateway
   *   openTo: the addresses that reach the load balancer’s listener, as a CIDR; everywhere
   */
  constructor(scope, id, { vpc, openTo = '0.0.0.0/0' } = {}) {
    super(scope, id);
    this.vpc = vpc ?? new Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });
    const group = (/** @type {string} */ name, /** @type {boolean} */ allowAllOutbound) => new SecurityGroup(this, name, { vpc: this.vpc, allowAllOutbound });
    // The load balancer: in from people over TLS; out to the identity provider over TLS and to Postbox, and nothing else.
    this.balancerGroup = group('BalancerGroup', false);
    // Postbox: in from the load balancer alone. Out, it reaches the key endpoint and the hosts its agents run on.
    this.serverGroup = group('ServerGroup', true);
    // The data folder’s disk: in from Postbox alone.
    this.diskGroup = group('DiskGroup', false);

    // EC2 takes only plain ASCII in a rule’s description.
    this.balancerGroup.addIngressRule(Peer.ipv4(openTo), Port.tcp(443), 'People, over TLS');
    this.balancerGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'The identity provider, over TLS');
    this.balancerGroup.addEgressRule(this.serverGroup, Port.tcp(PORT), 'Postbox');
    this.serverGroup.addIngressRule(this.balancerGroup, Port.tcp(PORT), 'The load balancer, and nothing else');
    this.diskGroup.addIngressRule(this.serverGroup, Port.tcp(2049), 'The data folder, from Postbox');
  }
}
