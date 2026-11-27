// The server of a hosted Postbox: one task of its image and the service that keeps exactly one running
// (designs/architecture/hosted.md, “One server, one disk”). It is the part that changes with every release and the
// one most likely to fail to start, so it is a part of its own: its failure leaves the network, the disk and the
// edge as they were.

import { Stack } from 'aws-cdk-lib';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
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
  Secret,
} from 'aws-cdk-lib/aws-ecs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NODE_USER } from './data.mjs';
import { PORT } from './network.mjs';

/** The image’s scratch volume, the one place besides /data its user can write, and its home (Dockerfile). */
const SCRATCH = '/run/postbox';

/**
 * What the server needs to reach its agent host, read by the task as it starts and never written in the template:
 * the key the host accepts, which only this task’s execution role may read, and the host’s address and public key.
 * A host that is replaced says them again, and the next task to start reads them.
 * @param {import('./agent-host.mjs').PostboxAgentHost} host
 */
const reachOf = (host) => ({
  POSTBOX_HOST_KEY: Secret.fromSsmParameter(host.key.privateKey),
  POSTBOX_HOST_ADDRESS: Secret.fromSsmParameter(host.address),
  POSTBOX_HOST_IDENTITY: Secret.fromSsmParameter(host.identity),
});

/**
 * @typedef {object} PostboxServerProps
 * @property {import('aws-cdk-lib/aws-ec2').IVpc} vpc
 * @property {import('aws-cdk-lib/aws-ec2').ISecurityGroup} serverGroup
 * @property {import('aws-cdk-lib/aws-efs').IFileSystem} disk
 * @property {import('aws-cdk-lib/aws-efs').IAccessPoint} folder
 * @property {import('aws-cdk-lib/aws-elasticloadbalancingv2').IApplicationTargetGroup} targets
 * @property {{ root: string, commit?: string }} source  the clone the image is built from, and its commit for the build line
 * @property {object} hosted  Postbox’s hosted settings, as its settings file holds them (server/hosted-settings.mjs)
 * @property {import('./agent-host.mjs').PostboxAgentHost} [host]  the agent host this server reaches over SSH, as
 *   “agents” in Settings › Hosts; left out, hosts are whatever people add that the server’s account can reach
 */

export class PostboxServer extends Construct {
  /** @param {Construct} scope @param {string} id @param {PostboxServerProps} props */
  constructor(scope, id, props) {
    super(scope, id);
    const task = this.task(props);
    this.service = new FargateService(this, 'Service', {
      cluster: new Cluster(this, 'Cluster', { vpc: props.vpc }),
      taskDefinition: task,
      securityGroups: [props.serverGroup],
      // No public address: it reaches the key endpoint and its hosts out through the VPC’s NAT gateway.
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      // “One server, one disk”: one writer. The old task stops before the new one starts, never two at once.
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
    });
    // Made after the host has said its public key, which the task reads once, as it starts.
    if (props.host) this.service.node.addDependency(props.host.ready);
    // Registered by its address and port. Who reaches whom is PostboxNetwork’s to say, so no rule is added here.
    props.targets.addTarget(this.service.loadBalancerTarget({ containerName: 'Postbox', containerPort: PORT }));
  }

  /**
   * One task: as the image’s own user, with no Linux capability, a disk it can’t write to but for /data and its
   * scratch volume, and a role that holds one thing, the data folder.
   * @param {PostboxServerProps} props
   */
  task({ disk, folder, source, hosted, host }) {
    const access = { accessPointId: folder.accessPointId, iam: 'ENABLED' };
    const task = new FargateTaskDefinition(this, 'Task', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: { cpuArchitecture: CpuArchitecture.ARM64, operatingSystemFamily: OperatingSystemFamily.LINUX },
      volumes: [
        { name: 'data', efsVolumeConfiguration: { fileSystemId: disk.fileSystemId, transitEncryption: 'ENABLED', authorizationConfig: access } },
        { name: 'scratch' },
      ],
    });
    // The role may mount the disk only through the access point, so as the image’s user in the data folder.
    task.taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
        resources: [disk.fileSystemArn],
        conditions: { StringEquals: { 'elasticfilesystem:AccessPointArn': folder.accessPointArn } },
      }),
    );
    const linuxParameters = new LinuxParameters(this, 'Linux');
    linuxParameters.dropCapabilities(Capability.ALL);
    const container = task.addContainer('Postbox', {
      image: ContainerImage.fromAsset(source.root, { platform: Platform.LINUX_ARM64, buildArgs: { POSTBOX_COMMIT: source.commit ?? '' } }),
      // What the deployment knows reaches the container as text, and Postbox and ssh read files: the image’s start
      // command writes them, then starts Postbox without these in its environment (infra/image/hosted-start.sh).
      environment: { POSTBOX_HOSTED: Stack.of(this).toJsonString(hosted), POSTBOX_PORT: String(PORT) },
      secrets: host ? reachOf(host) : undefined,
      command: ['postbox-hosted-start'],
      user: `${NODE_USER}:${NODE_USER}`,
      readonlyRootFilesystem: true,
      linuxParameters,
      portMappings: [{ containerPort: PORT }],
      logging: LogDrivers.awsLogs({ streamPrefix: 'postbox', logRetention: RetentionDays.ONE_MONTH }),
    });
    container.addMountPoints(
      { containerPath: '/data', sourceVolume: 'data', readOnly: false },
      { containerPath: SCRATCH, sourceVolume: 'scratch', readOnly: false },
    );
    this.logGroup = container.logDriverConfig?.options?.['awslogs-group'] ?? '';
    return task;
  }
}
