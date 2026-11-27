// The name people open a hosted Postbox at, and the listener’s certificate (designs/architecture/hosted.md, “The
// address it answers”). Postbox answers one public origin and no other, so this decides the origin once, for the load
// balancer’s sign-in callback and for Postbox’s own settings alike.

import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';

/**
 * One of two:
 * - a name in a hosted zone you have: the certificate is requested and proved through the zone, and the name is
 *   pointed at the load balancer;
 * - a certificate you bring, with the name your own DNS points at the load balancer, or with none, for the load
 *   balancer’s own name (a test: no public certificate covers that name, so browsers warn).
 * @typedef {{ domainName: string, hostedZone: import('aws-cdk-lib/aws-route53').IHostedZone }
 *          | { certificate: import('aws-cdk-lib/aws-certificatemanager').ICertificate, domainName?: string }} Address
 */

/**
 * @param {import('constructs').Construct} scope @param {Address} address
 * @param {import('aws-cdk-lib/aws-elasticloadbalancingv2').ApplicationLoadBalancer} balancer
 */
export function addressOf(scope, address, balancer) {
  if (address && 'hostedZone' in address) {
    const { domainName, hostedZone } = address;
    const certificate = new Certificate(scope, 'Certificate', { domainName, validation: CertificateValidation.fromDns(hostedZone) });
    new ARecord(scope, 'Name', { zone: hostedZone, recordName: domainName, target: RecordTarget.fromAlias(new LoadBalancerTarget(balancer)) });
    return { origin: `https://${domainName.toLowerCase()}`, certificate };
  }
  if (!address?.certificate) throw new Error('Give a hosted Postbox its address: a domainName in a hostedZone, or a certificate (infra/README.md).');
  // The load balancer’s own name is a token until it is deployed, so it is used as it is: edge.mjs names the balancer
  // in lower case, which makes its DNS name lower case too. A name given here is lower-cased, as Postbox’s origin must be.
  const origin = address.domainName ? `https://${address.domainName.toLowerCase()}` : `https://${balancer.loadBalancerDnsName}`;
  return { origin, certificate: address.certificate };
}
