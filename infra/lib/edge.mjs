// The edge of a hosted Postbox: the load balancer people reach, the name and certificate it answers with, and the
// sign-in every request passes before it is forwarded (designs/architecture/hosted.md, “The address it answers” and
// “Who is asking”). It stands without a server behind it: until one registers, a signed-in person gets the load
// balancer’s 503, and no one else gets anything.

import { Duration, Stack } from 'aws-cdk-lib';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  DesyncMitigationMode,
  ListenerAction,
  SslPolicy,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { addressOf } from './address.mjs';
import { PORT } from './network.mjs';
import { signInOf } from './sign-in.mjs';

export class PostboxEdge extends Construct {
  /**
   * @param {Construct} scope @param {string} id
   * @param {{ vpc: import('aws-cdk-lib/aws-ec2').IVpc, balancerGroup: import('aws-cdk-lib/aws-ec2').ISecurityGroup,
   *           address: import('./address.mjs').Address, signIn?: import('./sign-in.mjs').SignIn,
   *           sessionTimeout?: Duration, deletionProtection?: boolean }} props
   *   sessionTimeout: how long a sign-in at the load balancer lasts before the provider is asked again; 12 hours
   *   deletionProtection: whether the load balancer refuses to be deleted; true
   */
  constructor(scope, id, { vpc, balancerGroup, address, signIn, sessionTimeout = Duration.hours(12), deletionProtection = true }) {
    super(scope, id);
    // The name is lower case so that the balancer’s own DNS name is, since a browser lowers a host’s case and the
    // sign-in’s callback address has to match what the browser sends.
    this.balancer = new ApplicationLoadBalancer(this, 'Balancer', {
      vpc,
      internetFacing: true,
      securityGroup: balancerGroup,
      loadBalancerName: `${Stack.of(this).stackName.toLowerCase().slice(0, 23)}-postbox`,
      dropInvalidHeaderFields: true,
      desyncMitigationMode: DesyncMitigationMode.STRICTEST,
      deletionProtection,
    });
    const { origin, certificate } = addressOf(this, address, this.balancer);
    const provider = signInOf(this, signIn, { origin, sessionTimeout });
    this.origin = origin;
    /** What Postbox holds every token to: this load balancer, this client, this provider. None is a secret. */
    this.signedBy = { signer: this.balancer.loadBalancerArn, client: provider.clientId, issuer: provider.issuer };

    this.targets = new ApplicationTargetGroup(this, 'Targets', {
      vpc,
      port: PORT,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      // The one path Postbox answers with no sign-in and for any Host (“Who is asking”).
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(15), healthyThresholdCount: 2 },
      deregistrationDelay: Duration.seconds(10),
    });
    // The listener’s one action signs a person in and only then forwards, so no request reaches Postbox through the
    // load balancer without the token Postbox then checks itself.
    this.balancer.addListener('Https', {
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      sslPolicy: SslPolicy.TLS13_RES,
      certificates: [certificate],
      open: false,
      defaultAction: provider.action(ListenerAction.forward([this.targets])),
    });
  }
}
