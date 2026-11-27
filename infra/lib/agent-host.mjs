// An agent host of a hosted Postbox (designs/architecture/hosted.md, “What runs an agent host, weighed”): one
// machine where agents work, which the server reaches over SSH as it reaches any host (designs/remote-hosts.md).
// The server is a web server with one disk; this is the remote host machine. They are apart because an agent has a
// shell, and a shell beside the server would hold every room’s data.
//
// What is the machine’s alone, and why:
//   - its role may call Anthropic’s models on Amazon Bedrock, and nothing else. An agent can use that role, since
//     it runs on the machine, so the role holds nothing an agent shouldn’t have, and writes nothing the server reads;
//   - its work disk is a volume of its own, kept when the machine is replaced, with the agents’ folders, the
//     daemon’s records and the host’s SSH identity on it;
//   - SSH is admitted from the server’s security group alone (lib/network.mjs), for one key, made here, whose
//     private half only the server’s task reads.

import { readFileSync } from 'node:fs';
import { CfnWaitCondition, CfnWaitConditionHandle, Fn, RemovalPolicy, Size, Stack } from 'aws-cdk-lib';
import {
  AmazonLinuxCpuType,
  BlockDeviceVolume,
  CfnVolumeAttachment,
  EbsDeviceVolumeType,
  Instance,
  InstanceType,
  KeyPair,
  KeyPairType,
  MachineImage,
  SubnetType,
  UserData,
  Volume,
} from 'aws-cdk-lib/aws-ec2';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/** The device the work disk is attached as. Amazon Linux links this name to the NVMe device it becomes. */
const WORK_DEVICE = '/dev/sdf';
/**
 * The Claude Code a machine installs unless told another: one exact version, so two deployments make the same
 * machine and a release made after this line was written isn’t run as root unseen. Postbox’s hosts need 2.1.259 or
 * later (designs/remote-hosts.md).
 */
const CLAUDE_CODE = '2.1.332';
/** A version as npm takes one, and nothing a shell would read as more. */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const SETUP = readFileSync(new URL('../host/setup.sh', import.meta.url), 'utf8');

/**
 * @typedef {object} PostboxAgentHostProps
 * @property {import('aws-cdk-lib/aws-ec2').IVpc} vpc
 * @property {import('aws-cdk-lib/aws-ec2').ISecurityGroup} hostGroup  admits SSH from the server alone (PostboxNetwork)
 * @property {string} parameters  the prefix of this deployment’s parameters, such as /postbox/test: where the host
 *   says its public key and address, for the server to read as it starts
 * @property {string} [instanceType]  t4g.large: two ARM cores and 8 GB, for a few agents at once
 * @property {number} [workGiB]  the size of a new work disk; 100
 * @property {import('aws-cdk-lib/aws-ec2').IVolume} [workDisk]  a work disk kept from a machine before this one, in
 *   the availability zone of the VPC’s first private subnet; left out, a new one
 * @property {string} [claudeCode]  the version of Claude Code to install; CLAUDE_CODE above
 * @property {string} [codex]  a version of Codex to install; left out, Codex isn’t installed
 * @property {string[]} [models]  the ARNs of the models and inference profiles the role may call; left out,
 *   Anthropic’s models and the account’s inference profiles, in any region, since an inference profile calls across them
 * @property {boolean} [sessionManager]  lets an operator open a shell on the machine through Systems Manager; false.
 *   An agent on the machine holds the same permission, and with it could take the machine’s place in an operator’s
 *   session, so turn it on for a test and not where people’s rooms are
 */

export class PostboxAgentHost extends Construct {
  /** @param {Construct} scope @param {string} id @param {PostboxAgentHostProps} props */
  constructor(scope, id, props) {
    super(scope, id);
    const { vpc, hostGroup, parameters } = props;
    for (const version of [props.claudeCode, props.codex])
      if (version !== undefined && !VERSION.test(version)) throw new Error(`“${version}” isn’t a version of a CLI to install.`);
    const subnet = vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnets[0];
    // The key the server signs in with. EC2 makes it and keeps its private half in Parameter Store, encrypted, which
    // the server’s task reads as it starts; the machine is given the public half.
    this.key = new KeyPair(this, 'ServerKey', { type: KeyPairType.ED25519 });
    const done = new CfnWaitConditionHandle(this, 'Ready');

    this.machine = new Instance(this, 'Machine', {
      vpc,
      vpcSubnets: { subnets: [subnet] },
      securityGroup: hostGroup,
      instanceType: new InstanceType(props.instanceType ?? 't4g.large'),
      // Read once and kept in cdk.context.json, so a new Amazon Linux doesn’t replace the machine at the next deployment.
      machineImage: MachineImage.latestAmazonLinux2023({ cpuType: AmazonLinuxCpuType.ARM_64, cachedInContext: true }),
      keyPair: this.key,
      requireImdsv2: true,
      blockDevices: [{ deviceName: '/dev/xvda', volume: BlockDeviceVolume.ebs(30, { encrypted: true, volumeType: EbsDeviceVolumeType.GP3 }) }],
      userData: this.setup(props, done.ref),
    });
    this.address = new StringParameter(this, 'Address', { parameterName: `${parameters}/host/address`, stringValue: this.machine.instancePrivateIp });
    this.allow(props);

    const disk =
      props.workDisk ??
      new Volume(this, 'WorkDisk', {
        availabilityZone: subnet.availabilityZone,
        size: Size.gibibytes(props.workGiB ?? 100),
        volumeType: EbsDeviceVolumeType.GP3,
        encrypted: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    new CfnVolumeAttachment(this, 'WorkDiskAttached', { device: WORK_DEVICE, instanceId: this.machine.instanceId, volumeId: disk.volumeId });
    // The deployment waits here until the machine has set itself up and said its public key, which the deployment
    // then keeps where the server reads it as it starts. The machine’s role can’t write there: what the server
    // trusts a host by is said once, by the machine’s first start, and not again by anything that runs on it.
    this.ready = new CfnWaitCondition(this, 'IsReady', { handle: done.ref, timeout: '900', count: 1 });
    this.ready.node.addDependency(this.machine);
    // The condition’s data is {"host":"<what was said>"}: the fourth piece between its quotes.
    const said = Fn.select(3, Fn.split('"', this.ready.attrData.toString()));
    this.identity = new StringParameter(this, 'Identity', { parameterName: `${parameters}/host/identity`, stringValue: said });
  }

  /**
   * What the machine runs once, as root, at its first start: the steps of infra/host/setup.sh, then it says its
   * public key where the server reads it and tells the deployment whether that worked.
   * @param {PostboxAgentHostProps} props @param {string} done  the address the result is sent to
   */
  setup(props, done) {
    const { region } = Stack.of(this);
    return UserData.custom(
      [
        '#!/bin/bash',
        `DONE='${done}'`,
        // What the deployment is told, however this ends: the machine’s public key, or that its setup failed, which
        // rolls this part back at once.
        'tell() { curl -sS -X PUT -H "Content-Type:" --data-binary "{\\"Status\\":\\"$1\\",\\"Reason\\":\\"The agent host setup\\",\\"UniqueId\\":\\"host\\",\\"Data\\":\\"$2\\"}" "$DONE"; }',
        'IDENTITY=',
        'trap \'if [ -n "$IDENTITY" ]; then tell SUCCESS "$IDENTITY"; else tell FAILURE failed; fi\' EXIT',
        'set -euo pipefail',
        `export POSTBOX_WORK_DEVICE=${WORK_DEVICE} POSTBOX_REGION=${region} POSTBOX_CLAUDE_CODE=${props.claudeCode ?? CLAUDE_CODE} POSTBOX_CODEX=${props.codex ?? ''}`,
        // The public half of the server’s key, from the machine’s own metadata, then gone from the default account.
        'TOKEN=$(curl -sS -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)',
        'POSTBOX_SERVER_KEY=$(curl -sS -f -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-keys/0/openssh-key | cut -d" " -f1,2)',
        'export POSTBOX_SERVER_KEY',
        'rm -f ~ec2-user/.ssh/authorized_keys',
        "cat > /root/postbox-setup.sh <<'POSTBOX_SETUP'",
        SETUP,
        'POSTBOX_SETUP',
        'SAID=$(bash /root/postbox-setup.sh | tail -n 1)',
        // Only a key is passed on: it becomes a line of the server’s known_hosts.
        '[[ "$SAID" =~ ^ssh-ed25519\\ [A-Za-z0-9+/=]+$ ]] && IDENTITY=$SAID',
      ].join('\n'),
    );
  }

  /**
   * The machine’s role, which an agent on it can use: Anthropic’s models, and nothing else. Nothing of the server’s,
   * and no parameter.
   * @param {PostboxAgentHostProps} props
   */
  allow({ models, sessionManager = false }) {
    const stack = Stack.of(this);
    const { role } = this.machine;
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: models ?? [
          'arn:aws:bedrock:*::foundation-model/anthropic.*',
          stack.formatArn({ service: 'bedrock', region: '*', resource: 'inference-profile', resourceName: '*' }),
          stack.formatArn({ service: 'bedrock', region: '*', resource: 'application-inference-profile', resourceName: '*' }),
        ],
      }),
    );
    role.addToPrincipalPolicy(new PolicyStatement({ actions: ['bedrock:ListInferenceProfiles', 'bedrock:ListFoundationModels'], resources: ['*'] }));
    // A shell for an operator, through Systems Manager, with no port opened. Only what a session needs: the managed
    // policy for this also reads every parameter in the account, which an agent on the machine would then read too.
    if (sessionManager)
      role.addToPrincipalPolicy(
        new PolicyStatement({
          actions: [
            'ssm:UpdateInstanceInformation',
            'ssmmessages:CreateControlChannel',
            'ssmmessages:CreateDataChannel',
            'ssmmessages:OpenControlChannel',
            'ssmmessages:OpenDataChannel',
          ],
          resources: ['*'],
        }),
      );
  }
}
