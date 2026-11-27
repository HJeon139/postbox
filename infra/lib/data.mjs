// The disk a hosted Postbox’s data folder is on (designs/architecture/hosted.md, “One server, one disk”). It is a part
// of its own because it is the one thing here that can’t be made again: every room, upload and profile is on it. It
// outlives the server, and the stack too unless you delete it yourself.

import { RemovalPolicy } from 'aws-cdk-lib';
import { FileSystem } from 'aws-cdk-lib/aws-efs';
import { AnyPrincipal, Effect, PolicyDocument, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** The image’s `node` user, which owns the data folder. */
export const NODE_USER = '1000';

export class PostboxData extends Construct {
  /**
   * @param {Construct} scope @param {string} id
   * @param {{ vpc: import('aws-cdk-lib/aws-ec2').IVpc, diskGroup: import('aws-cdk-lib/aws-ec2').ISecurityGroup }} props
   */
  constructor(scope, id, { vpc, diskGroup }) {
    super(scope, id);
    // Its own policy allows no one and refuses anything not over TLS, so nothing mounts it on the strength of reaching
    // it. The one grant is on the server’s role, through the access point (PostboxServer).
    const overTls = new PolicyStatement({
      effect: Effect.DENY,
      principals: [new AnyPrincipal()],
      actions: ['*'],
      conditions: { Bool: { 'aws:SecureTransport': 'false' } },
    });
    this.disk = new FileSystem(this, 'Disk', {
      vpc,
      securityGroup: diskGroup,
      encrypted: true,
      enableAutomaticBackups: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // Said outright so CDK adds no statement of its own: the policy below is the whole of it.
      allowAnonymousAccess: true,
      fileSystemPolicy: new PolicyDocument({ statements: [overTls] }),
    });
    // Whoever mounts through this is the image’s user, in this one folder, never root at the disk’s top.
    this.folder = this.disk.addAccessPoint('Folder', {
      path: '/postbox',
      createAcl: { ownerUid: NODE_USER, ownerGid: NODE_USER, permissions: '700' },
      posixUser: { uid: NODE_USER, gid: NODE_USER },
    });
  }
}
