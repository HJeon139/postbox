// A hosted Postbox on AWS, as one construct to put in a stack of your own (designs/architecture/hosted.md, “The test
// deployment on AWS”; infra/README.md):
//
//   Browser → ALB (TLS, sign-in) → one Fargate task (Postbox, port 8080) → EFS (the data folder)
//
// It brings what it isn’t given, and uses what it is: a VPC, a name in a hosted zone or a certificate, and the
// identity provider a team already has (a Cognito user pool, or any OIDC provider). Who may sign in is Postbox’s own
// allow list, checked by Postbox on every request, so being able to sign in at the provider admits no one by itself.
// What the design asks of a deployment is each a line here or in a part beside it, marked with the section that asks it.

import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, ListenerAction, SslPolicy } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { addressOf } from './address.mjs';
import { serverOf } from './server.mjs';
import { signInOf } from './sign-in.mjs';

export const PORT = 8080;

/**
 * @typedef {object} HostedPostboxProps
 * @property {{ root: string, commit?: string }} source  the clone the image is built from, and its commit for the build line
 * @property {import('./address.mjs').Address} address  the name people open and its certificate
 * @property {import('./sign-in.mjs').SignIn} [signIn]  the identity provider to use; left out, a new Cognito user pool
 * @property {{ username: string, name: string }} [claims]  the claims that hold a person’s user name and name; `email` and `name`
 * @property {{ subjects?: string[], groups?: { claim: string, any: string[] } }} [allow]  who may sign in. Left out or
 *   empty, no one may: Postbox doesn’t start without an allow list (#1733), so it is given one that names no one
 * @property {import('aws-cdk-lib/aws-ec2').IVpc} [vpc]  left out, a new one with public subnets and no NAT gateway
 * @property {string} [openTo]  the addresses that reach the listener, as a CIDR; everywhere
 * @property {Duration} [sessionTimeout]  how long a sign-in at the load balancer lasts before the provider is asked again; 12 hours
 */

/**
 * The load balancer, which people reach over TLS and nothing else.
 * @param {Construct} scope @param {import('aws-cdk-lib/aws-ec2').IVpc} vpc @param {string} openTo
 */
function balancerOf(scope, vpc, openTo) {
  const balancerGroup = new SecurityGroup(scope, 'BalancerGroup', { vpc, allowAllOutbound: true });
  balancerGroup.addIngressRule(Peer.ipv4(openTo), Port.tcp(443), 'People, over TLS');
  // The name is lower case so that the balancer’s own DNS name is, since a browser lowers a host’s case and the
  // sign-in’s callback address has to match what the browser sends.
  const balancer = new ApplicationLoadBalancer(scope, 'Balancer', {
    vpc,
    internetFacing: true,
    securityGroup: balancerGroup,
    loadBalancerName: `${Stack.of(scope).stackName.toLowerCase().slice(0, 23)}-postbox`,
    dropInvalidHeaderFields: true,
  });
  return { balancer, balancerGroup };
}

/**
 * The listener. Its one action signs a person in and only then forwards, so no request reaches Postbox through the
 * load balancer without the token Postbox then checks itself.
 * @param {Construct} scope
 * @param {{ vpc: import('aws-cdk-lib/aws-ec2').IVpc, balancer: ApplicationLoadBalancer, certificate: import('aws-cdk-lib/aws-certificatemanager').ICertificate,
 *           service: import('aws-cdk-lib/aws-ecs').FargateService, signIn: ReturnType<typeof signInOf> }} props
 */
function listenerOf(scope, { vpc, balancer, certificate, service, signIn }) {
  const targets = new ApplicationTargetGroup(scope, 'Targets', {
    vpc,
    port: PORT,
    protocol: ApplicationProtocol.HTTP,
    targets: [service],
    // The one path Postbox answers with no sign-in and for any Host (“Who is asking”).
    healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(15), healthyThresholdCount: 2 },
    deregistrationDelay: Duration.seconds(10),
  });
  return balancer.addListener('Https', {
    port: 443,
    protocol: ApplicationProtocol.HTTPS,
    sslPolicy: SslPolicy.RECOMMENDED_TLS,
    certificates: [certificate],
    open: false,
    defaultAction: signIn.action(ListenerAction.forward([targets])),
  });
}

export class HostedPostbox extends Construct {
  /** @param {Construct} scope @param {string} id @param {HostedPostboxProps} props */
  constructor(scope, id, props) {
    super(scope, id);
    const vpc = props.vpc ?? new Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 0, subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC }] });
    const { balancer, balancerGroup } = balancerOf(this, vpc, props.openTo ?? '0.0.0.0/0');
    const { origin, certificate } = addressOf(this, props.address, balancer);
    const signIn = signInOf(this, props.signIn, { origin, sessionTimeout: props.sessionTimeout ?? Duration.hours(12) });

    // “Who is asking”: what Postbox checks each request’s token against. It names this load balancer, this client and
    // this provider, and nothing in it is a secret or says who anyone is.
    const allow = props.allow?.subjects?.length || props.allow?.groups ? props.allow : { subjects: ['no-one-yet'] };
    const hosted = {
      origin,
      signIn: {
        provider: 'alb',
        region: Stack.of(this).region,
        signer: balancer.loadBalancerArn,
        client: signIn.clientId,
        issuer: signIn.issuer,
        claims: props.claims ?? { username: 'email', name: 'name' },
        allow,
      },
    };
    const { service, container } = serverOf(this, { vpc, source: props.source, hosted, balancerGroup });
    listenerOf(this, { vpc, balancer, certificate, service, signIn });

    this.origin = origin;
    this.balancer = balancer;
    this.service = service;
    new CfnOutput(this, 'Url', { value: origin });
    new CfnOutput(this, 'LogGroup', { value: container.logDriverConfig?.options?.['awslogs-group'] ?? '' });
  }
}
