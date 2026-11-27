// A hosted Postbox on AWS, for a test (designs/architecture/hosted.md, “The test deployment on AWS”): one load
// balancer that signs people in, one task of the server’s image, and one disk.
//
//   Browser → ALB (TLS, Cognito sign-in) → one Fargate task (Postbox, port 8080) → EFS (the data folder)
//
// What the design asks of a deployment is each a line here, marked with the section that asks it.

import { CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { OAuthScope, UserPool, UserPoolClientIdentityProvider } from 'aws-cdk-lib/aws-cognito';
import { Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Cluster, ContainerImage, CpuArchitecture, FargateService, FargateTaskDefinition, LogDrivers, OperatingSystemFamily } from 'aws-cdk-lib/aws-ecs';
import { FileSystem } from 'aws-cdk-lib/aws-efs';
import { ApplicationLoadBalancer, ApplicationProtocol, ListenerAction } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { AuthenticateCognitoAction } from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

const PORT = 8080;
/** The image’s `node` user, which owns the data folder. */
const NODE_USER = '1000';

/**
 * The network and the load balancer. No NAT gateway: the task has a public address to reach ECR, the key endpoint and
 * its hosts, and its security group (theServer) is what keeps everything but the load balancer away from its port.
 * @param {Stack} stack @param {{ openTo: string }} props
 */
function theEdge(stack, { openTo }) {
  const vpc = new Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0, subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC }] });
  const balancerGroup = new SecurityGroup(stack, 'BalancerGroup', { vpc, allowAllOutbound: true });
  balancerGroup.addIngressRule(Peer.ipv4(openTo), Port.tcp(443), 'People, over TLS');
  // The name is lower case so that the balancer’s own DNS name is, since a browser lowers a host’s case and the
  // sign-in’s callback address has to match what the browser sends.
  const balancer = new ApplicationLoadBalancer(stack, 'Balancer', {
    vpc,
    internetFacing: true,
    securityGroup: balancerGroup,
    loadBalancerName: `${stack.node.id.toLowerCase()}-postbox`,
  });
  return { vpc, balancer, balancerGroup };
}

/**
 * Sign-in: a user pool whose people an administrator makes. Nobody signs themselves up.
 * @param {Stack} stack @param {string} origin
 */
function thePeople(stack, origin) {
  const pool = new UserPool(stack, 'People', {
    selfSignUpEnabled: false,
    signInAliases: { email: true },
    standardAttributes: { fullname: { required: true, mutable: true } },
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const client = pool.addClient('Balancer', {
    generateSecret: true,
    supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
    oAuth: {
      flows: { authorizationCodeGrant: true },
      scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
      callbackUrls: [`${origin}/oauth2/idpresponse`],
    },
  });
  // A sign-in page’s prefix is one name for all of AWS, so it carries this stack’s own id.
  const domain = pool.addDomain('SignInPage', { cognitoDomain: { domainPrefix: `postbox-${Fn.select(2, Fn.split('/', stack.stackId))}` } });
  return { pool, client, domain };
}

/**
 * “One server, one disk”: the data folder outlives the task, and the image’s `node` user owns it.
 * @param {Stack} stack @param {Vpc} vpc
 */
function theDisk(stack, vpc) {
  const disk = new FileSystem(stack, 'Data', { vpc, encrypted: true, removalPolicy: RemovalPolicy.DESTROY });
  const folder = disk.addAccessPoint('Folder', {
    path: '/postbox',
    createAcl: { ownerUid: NODE_USER, ownerGid: NODE_USER, permissions: '700' },
    posixUser: { uid: NODE_USER, gid: NODE_USER },
  });
  return { disk, folder };
}

/**
 * The server: one task of the image, started with the hosted settings, with the data folder mounted.
 * @param {Stack} stack
 * @param {{ root: string, commit: string, hosted: object, disk: FileSystem, folder: import('aws-cdk-lib/aws-efs').AccessPoint }} props
 */
function theTask(stack, { root, commit, hosted, disk, folder }) {
  const access = { accessPointId: folder.accessPointId, iam: 'ENABLED' };
  const task = new FargateTaskDefinition(stack, 'Task', {
    cpu: 512,
    memoryLimitMiB: 1024,
    runtimePlatform: { cpuArchitecture: CpuArchitecture.ARM64, operatingSystemFamily: OperatingSystemFamily.LINUX },
    volumes: [{ name: 'data', efsVolumeConfiguration: { fileSystemId: disk.fileSystemId, transitEncryption: 'ENABLED', authorizationConfig: access } }],
  });
  disk.grantReadWrite(task.taskRole);
  const container = task.addContainer('Postbox', {
    image: ContainerImage.fromAsset(root, { platform: Platform.LINUX_ARM64, buildArgs: { POSTBOX_COMMIT: commit } }),
    // The settings reach the container as text, and Postbox reads a file: the command writes one, then starts it.
    environment: { POSTBOX_HOSTED: stack.toJsonString(hosted) },
    command: [
      'sh',
      '-c',
      `printf '%s' "$POSTBOX_HOSTED" > /tmp/hosted.json && exec node bin/postbox.mjs --hosted /tmp/hosted.json --data /data --port ${PORT}`,
    ],
    portMappings: [{ containerPort: PORT }],
    logging: LogDrivers.awsLogs({ streamPrefix: 'postbox', logRetention: RetentionDays.ONE_MONTH }),
  });
  container.addMountPoints({ containerPath: '/data', sourceVolume: 'data', readOnly: false });
  return { task, container };
}

/**
 * The service that keeps the one task running, reachable by the load balancer alone.
 * @param {Stack} stack
 * @param {{ vpc: Vpc, task: FargateTaskDefinition, disk: FileSystem, balancerGroup: SecurityGroup }} props
 */
function theService(stack, { vpc, task, disk, balancerGroup }) {
  // “Network rules” (the owner, 26 November 2026): only the load balancer reaches Postbox’s port.
  const taskGroup = new SecurityGroup(stack, 'TaskGroup', { vpc, allowAllOutbound: true });
  taskGroup.addIngressRule(balancerGroup, Port.tcp(PORT), 'The load balancer, and nothing else');
  // EC2 takes only plain ASCII in a rule’s description.
  disk.connections.allowDefaultPortFrom(taskGroup, 'The data folder, from the task');
  return new FargateService(stack, 'Service', {
    cluster: new Cluster(stack, 'Cluster', { vpc }),
    taskDefinition: task,
    securityGroups: [taskGroup],
    assignPublicIp: true,
    // “One server, one disk”: one writer. The old task stops before the new one starts, never two at once.
    desiredCount: 1,
    minHealthyPercent: 0,
    maxHealthyPercent: 100,
    circuitBreaker: { rollback: true },
  });
}

/**
 * The listener: every request is signed in at the load balancer first, and reaches Postbox with the token it then
 * checks itself.
 * @param {Stack} stack
 * @param {{ balancer: ApplicationLoadBalancer, certificateArn: string, service: FargateService, people: ReturnType<typeof thePeople> }} props
 */
function theListener(stack, { balancer, certificateArn, service, people }) {
  const listener = balancer.addListener('Https', {
    port: 443,
    protocol: ApplicationProtocol.HTTPS,
    certificates: [Certificate.fromCertificateArn(stack, 'Certificate', certificateArn)],
    open: false,
  });
  const targets = listener.addTargets('Postbox', {
    port: PORT,
    protocol: ApplicationProtocol.HTTP,
    targets: [service],
    // The one path Postbox answers with no sign-in and for any Host (“Who is asking”).
    healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(15), healthyThresholdCount: 2 },
    deregistrationDelay: Duration.seconds(10),
  });
  const signIn = { userPool: people.pool, userPoolClient: people.client, userPoolDomain: people.domain };
  listener.addAction('SignIn', { action: new AuthenticateCognitoAction({ ...signIn, next: ListenerAction.forward([targets]) }) });
}

export class PostboxStack extends Stack {
  /**
   * @param {import('constructs').Construct} scope @param {string} id
   * @param {import('aws-cdk-lib').StackProps & { root: string, commit: string, certificateArn?: string, domainName?: string,
   *          allowSubjects: string[], openTo: string }} props
   *   root: the clone, which the image is built from; certificateArn: the listener’s certificate in ACM;
   *   domainName: the name people open, when DNS points one at the load balancer, else the balancer’s own name;
   *   allowSubjects: who may sign in, by their subject in the user pool; openTo: the addresses that reach the listener
   */
  constructor(scope, id, props) {
    super(scope, id, props);
    const { certificateArn } = props;
    if (!certificateArn) throw new Error('Give the listener’s certificate: -c certificateArn=<an ACM certificate’s ARN> (infra/README.md).');

    const { vpc, balancer, balancerGroup } = theEdge(this, props);
    const origin = `https://${props.domainName ?? balancer.loadBalancerDnsName}`;
    const people = thePeople(this, origin);
    // “Who is asking”: what Postbox checks each request’s token against. It names this load balancer, this client and
    // this pool, and nothing in it is a secret or says who anyone is.
    const hosted = {
      origin,
      signIn: {
        provider: 'alb',
        region: this.region,
        signer: balancer.loadBalancerArn,
        client: people.client.userPoolClientId,
        issuer: people.pool.userPoolProviderUrl,
        claims: { username: 'email', name: 'name' },
        // Postbox doesn’t start without an allow list (#1733). Before anyone is in the pool there is no subject to
        // name, so the first deployment names one that can’t exist, and admits no one.
        allow: { subjects: props.allowSubjects.length ? props.allowSubjects : ['no-one-yet'] },
      },
    };
    const { disk, folder } = theDisk(this, vpc);
    const { task, container } = theTask(this, { root: props.root, commit: props.commit, hosted, disk, folder });
    const service = theService(this, { vpc, task, disk, balancerGroup });
    theListener(this, { balancer, certificateArn, service, people });

    new CfnOutput(this, 'Url', { value: origin });
    new CfnOutput(this, 'UserPoolId', { value: people.pool.userPoolId });
    new CfnOutput(this, 'LogGroup', { value: container.logDriverConfig?.options?.['awslogs-group'] ?? '' });
  }
}
