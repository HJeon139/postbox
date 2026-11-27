// The server of a hosted Postbox: one task of its image, the disk its data folder is on, and the service that keeps
// one running, reachable by the load balancer alone (designs/architecture/hosted.md, “One server, one disk”).

import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Port, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import {
  Capability,
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LinuxParameters,
  LogDrivers,
  OperatingSystemFamily,
} from 'aws-cdk-lib/aws-ecs';
import { FileSystem } from 'aws-cdk-lib/aws-efs';
import { AnyPrincipal, Effect, PolicyDocument, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

const PORT = 8080;
/** The image’s `node` user, which owns the data folder. */
const NODE_USER = '1000';

/** The data folder’s disk: it outlives the task, and the stack too unless you delete it. */
function diskOf(scope, vpc) {
  // Its own policy allows no one and refuses anything not over TLS, so nothing mounts it on the strength of reaching it.
  // The one grant is on the task’s role, through the access point (serverOf).
  const overTls = new PolicyStatement({
    effect: Effect.DENY,
    principals: [new AnyPrincipal()],
    actions: ['*'],
    conditions: { Bool: { 'aws:SecureTransport': 'false' } },
  });
  const disk = new FileSystem(scope, 'Data', {
    vpc,
    encrypted: true,
    enableAutomaticBackups: true,
    removalPolicy: RemovalPolicy.RETAIN,
    // Said outright so CDK adds no statement of its own: the policy below is the whole of it.
    allowAnonymousAccess: true,
    fileSystemPolicy: new PolicyDocument({ statements: [overTls] }),
  });
  const folder = disk.addAccessPoint('Folder', {
    path: '/postbox',
    createAcl: { ownerUid: NODE_USER, ownerGid: NODE_USER, permissions: '700' },
    posixUser: { uid: NODE_USER, gid: NODE_USER },
  });
  return { disk, folder };
}

/**
 * One task of the server’s image: as the image’s own user, with no Linux capability, a disk it can’t write to but for
 * /data and /tmp, and a role that holds one thing, the data folder.
 * @param {import('constructs').Construct} scope
 * @param {{ source: { root: string, commit?: string }, hosted: object, disk: FileSystem, folder: import('aws-cdk-lib/aws-efs').AccessPoint }} props
 */
function taskOf(scope, { source, hosted, disk, folder }) {
  const access = { accessPointId: folder.accessPointId, iam: 'ENABLED' };
  const task = new FargateTaskDefinition(scope, 'Task', {
    cpu: 512,
    memoryLimitMiB: 1024,
    runtimePlatform: { cpuArchitecture: CpuArchitecture.ARM64, operatingSystemFamily: OperatingSystemFamily.LINUX },
    volumes: [
      { name: 'data', efsVolumeConfiguration: { fileSystemId: disk.fileSystemId, transitEncryption: 'ENABLED', authorizationConfig: access } },
      { name: 'tmp' }, // the one other place the container writes: its own disk is read-only
    ],
  });
  // The task’s role may mount the disk only through the access point, so as the image’s user in the data folder and
  // never as root at the disk’s top. It holds nothing else in the account.
  task.taskRole.addToPrincipalPolicy(
    new PolicyStatement({
      actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
      resources: [disk.fileSystemArn],
      conditions: { StringEquals: { 'elasticfilesystem:AccessPointArn': folder.accessPointArn } },
    }),
  );
  const linuxParameters = new LinuxParameters(scope, 'Linux');
  linuxParameters.dropCapabilities(Capability.ALL);
  const container = task.addContainer('Postbox', {
    image: ContainerImage.fromAsset(source.root, { platform: Platform.LINUX_ARM64, buildArgs: { POSTBOX_COMMIT: source.commit ?? '' } }),
    // The settings reach the container as text, and Postbox reads a file: the command writes one, then starts it.
    environment: { POSTBOX_HOSTED: Stack.of(scope).toJsonString(hosted), HOME: '/tmp' },
    // As the image’s own user, with no Linux capability and a disk it can’t write to but for /data and /tmp.
    user: `${NODE_USER}:${NODE_USER}`,
    readonlyRootFilesystem: true,
    linuxParameters,
    command: [
      'sh',
      '-c',
      `printf '%s' "$POSTBOX_HOSTED" > /tmp/hosted.json && exec node bin/postbox.mjs --hosted /tmp/hosted.json --data /data --port ${PORT}`,
    ],
    portMappings: [{ containerPort: PORT }],
    logging: LogDrivers.awsLogs({ streamPrefix: 'postbox', logRetention: RetentionDays.ONE_MONTH }),
  });
  container.addMountPoints({ containerPath: '/data', sourceVolume: 'data', readOnly: false }, { containerPath: '/tmp', sourceVolume: 'tmp', readOnly: false });

  return { task, container };
}

/**
 * @param {import('constructs').Construct} scope
 * @param {{ vpc: import('aws-cdk-lib/aws-ec2').IVpc, source: { root: string, commit?: string }, hosted: object, balancerGroup: SecurityGroup }} props
 *   hosted: Postbox’s hosted settings, as its settings file holds them (server/hosted-settings.mjs)
 */
export function serverOf(scope, { vpc, source, hosted, balancerGroup }) {
  const { disk, folder } = diskOf(scope, vpc);
  const { task, container } = taskOf(scope, { source, hosted, disk, folder });

  // “Network rules” (the owner, 26 November 2026): only the load balancer reaches Postbox’s port. This is the second
  // line: Postbox checks the load balancer’s signed token on every request whatever reaches it.
  const taskGroup = new SecurityGroup(scope, 'TaskGroup', { vpc, allowAllOutbound: true });
  taskGroup.addIngressRule(balancerGroup, Port.tcp(PORT), 'The load balancer, and nothing else');
  balancerGroup.addEgressRule(taskGroup, Port.tcp(PORT), 'Postbox');
  // EC2 takes only plain ASCII in a rule’s description.
  disk.connections.allowDefaultPortFrom(taskGroup, 'The data folder, from the task');
  const service = new FargateService(scope, 'Service', {
    cluster: new Cluster(scope, 'Cluster', { vpc }),
    taskDefinition: task,
    securityGroups: [taskGroup],
    // No public address: it reaches the key endpoint and its hosts out through the VPC’s NAT gateway.
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    assignPublicIp: false,
    // “One server, one disk”: one writer. The old task stops before the new one starts, never two at once.
    desiredCount: 1,
    minHealthyPercent: 0,
    maxHealthyPercent: 100,
    circuitBreaker: { rollback: true },
  });
  return { service, container };
}
