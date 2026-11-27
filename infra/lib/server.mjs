// The server of a hosted Postbox: one task of its image, the disk its data folder is on, and the service that keeps
// one running, reachable by the load balancer alone (designs/architecture/hosted.md, “One server, one disk”).

import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Cluster, ContainerImage, CpuArchitecture, FargateService, FargateTaskDefinition, LogDrivers, OperatingSystemFamily } from 'aws-cdk-lib/aws-ecs';
import { FileSystem } from 'aws-cdk-lib/aws-efs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

const PORT = 8080;
/** The image’s `node` user, which owns the data folder. */
const NODE_USER = '1000';

/** The data folder’s disk: it outlives the task, and the stack too unless you delete it. */
function diskOf(scope, vpc) {
  const disk = new FileSystem(scope, 'Data', { vpc, encrypted: true, enableAutomaticBackups: true, removalPolicy: RemovalPolicy.RETAIN });
  const folder = disk.addAccessPoint('Folder', {
    path: '/postbox',
    createAcl: { ownerUid: NODE_USER, ownerGid: NODE_USER, permissions: '700' },
    posixUser: { uid: NODE_USER, gid: NODE_USER },
  });
  return { disk, folder };
}

/**
 * @param {import('constructs').Construct} scope
 * @param {{ vpc: import('aws-cdk-lib/aws-ec2').IVpc, source: { root: string, commit?: string }, hosted: object, balancerGroup: SecurityGroup }} props
 *   hosted: Postbox’s hosted settings, as its settings file holds them (server/hosted-settings.mjs)
 */
export function serverOf(scope, { vpc, source, hosted, balancerGroup }) {
  const { disk, folder } = diskOf(scope, vpc);
  const access = { accessPointId: folder.accessPointId, iam: 'ENABLED' };
  const task = new FargateTaskDefinition(scope, 'Task', {
    cpu: 512,
    memoryLimitMiB: 1024,
    runtimePlatform: { cpuArchitecture: CpuArchitecture.ARM64, operatingSystemFamily: OperatingSystemFamily.LINUX },
    volumes: [{ name: 'data', efsVolumeConfiguration: { fileSystemId: disk.fileSystemId, transitEncryption: 'ENABLED', authorizationConfig: access } }],
  });
  // The task’s role reaches its own data folder and nothing else in the account.
  disk.grantReadWrite(task.taskRole);
  const container = task.addContainer('Postbox', {
    image: ContainerImage.fromAsset(source.root, { platform: Platform.LINUX_ARM64, buildArgs: { POSTBOX_COMMIT: source.commit ?? '' } }),
    // The settings reach the container as text, and Postbox reads a file: the command writes one, then starts it.
    environment: { POSTBOX_HOSTED: Stack.of(scope).toJsonString(hosted) },
    command: [
      'sh',
      '-c',
      `printf '%s' "$POSTBOX_HOSTED" > /tmp/hosted.json && exec node bin/postbox.mjs --hosted /tmp/hosted.json --data /data --port ${PORT}`,
    ],
    portMappings: [{ containerPort: PORT }],
    logging: LogDrivers.awsLogs({ streamPrefix: 'postbox', logRetention: RetentionDays.ONE_MONTH }),
  });
  container.addMountPoints({ containerPath: '/data', sourceVolume: 'data', readOnly: false });

  // “Network rules” (the owner, 26 November 2026): only the load balancer reaches Postbox’s port. This is the second
  // line: Postbox checks the load balancer’s signed token on every request whatever reaches it.
  const taskGroup = new SecurityGroup(scope, 'TaskGroup', { vpc, allowAllOutbound: true });
  taskGroup.addIngressRule(balancerGroup, Port.tcp(PORT), 'The load balancer, and nothing else');
  // EC2 takes only plain ASCII in a rule’s description.
  disk.connections.allowDefaultPortFrom(taskGroup, 'The data folder, from the task');
  const service = new FargateService(scope, 'Service', {
    cluster: new Cluster(scope, 'Cluster', { vpc }),
    taskDefinition: task,
    securityGroups: [taskGroup],
    assignPublicIp: true,
    // “One server, one disk”: one writer. The old task stops before the new one starts, never two at once.
    desiredCount: 1,
    minHealthyPercent: 0,
    maxHealthyPercent: 100,
    circuitBreaker: { rollback: true },
  });
  return { service, container };
}
