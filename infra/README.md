# A hosted Postbox on AWS, for a test

This folder deploys one hosted Postbox to your own AWS account, to prove its edge against a real load balancer. Why it is shaped this way is in [designs/architecture/hosted.md](../designs/architecture/hosted.md), “The test deployment on AWS”. A hosted Postbox isn’t finished: that document’s “Status” says what works, and until rooms follow membership, everyone you let sign in reaches every room.

It is a CDK app in plain JavaScript, with its own `package.json`. The `postbox` package still has no dependencies: nothing here ships in it.

## The architecture

What a deployment is, with each part in the construct that makes it. The numbers are the order a request meets them.

```mermaid
flowchart LR
  B([Browser])
  subgraph yours [Yours]
    Z[Hosted zone, or a certificate]
    I[Identity provider, or a new user pool]
  end
  subgraph net [PostboxNetwork: one VPC]
    subgraph public [Public subnets]
      subgraph edge [PostboxEdge]
        LB[Load balancer]
      end
      N[NAT gateway]
    end
    subgraph private [Private subnets]
      subgraph server [PostboxServer]
        S[Postbox, one task]
      end
      subgraph data [PostboxData]
        D[(Data folder)]
      end
      subgraph host [PostboxAgentHost]
        H[Agent host, one machine]
        W[(Work disk)]
      end
    end
  end
  M[Amazon Bedrock]
  Z -. "the name and its certificate" .-> LB
  B -->|"1 HTTPS"| LB
  LB -->|"2 sign-in"| I
  LB -->|"3 HTTP 8080, with the token it signed"| S
  S --- D
  S -->|"4 ssh, with the one key the host accepts"| H
  H --- W
  H -->|"5 the models, by its role"| M
  S -->|"its key lookups, and apps’ fetches"| N
  X([Anything else]) -. "no address, no rule, no token" .-> S
```

| Part | What it does | What protects it |
|---|---|---|
| Load balancer | Ends TLS, signs each person in at the provider, and forwards the request with a token it signs | TLS 1.2 and later, one listener, one action: no request is forwarded unsigned |
| Postbox | Checks that token on every request, then its own allow list, then answers | No public address; port 8080 admitted from the load balancer’s security group alone; a read-only container with no capability |
| Data folder | Every room, upload and profile, on EFS | Mounted by the task’s role alone, through one access point, over TLS |
| Agent host | Where agents work: Node, git and Claude Code, as one account with no sudo, which the server reaches over `ssh` as it reaches any host ([remote-hosts.md](../designs/remote-hosts.md)) | No public address; port 22 admitted from the server’s security group alone, for one key; it reaches neither Postbox’s port nor the data folder |
| Work disk | The agents’ folders, their sessions, the daemon’s records and the host’s SSH identity, on a volume that is kept when the machine is replaced | Encrypted; attached to this machine alone |
| Amazon Bedrock | The models Claude Code calls | The machine’s role, which may call Anthropic’s models, and have Bedrock turn one on at its first call, and nothing else of yours; no key is written anywhere |
| NAT gateway | The only way out, for the server and the agent host: the load balancer’s signing key, AWS, what apps fetch, `ssh` to hosts, and what agents install and clone | The server’s security group lets out ports 443 and 80, 22 for hosts, and 2049 to its disk alone; the host’s lets out 443, 80 and 22 |

**The server and the agent host are two machines on purpose.** The server is a web server with one disk. An agent has a shell, and a shell beside the server would hold every room’s data, so agents work on a machine that can reach neither. Why it is an EC2 instance and not a Fargate task, a Kubernetes pod, Ray Serve or AgentCore Runtime is in hosted.md, “What runs an agent host, weighed”.

## What it makes, and what it costs

With nothing of yours given: one VPC with public and private subnets and one NAT gateway, one Application Load Balancer, one Cognito user pool, one ECS cluster with one Fargate task (0.5 vCPU, 1 GB, ARM64), one EFS file system, one log group, and one EC2 instance (`t4g.large`, ARM64) with a 100 GiB volume. Left running, the load balancer, the NAT gateway, the task and the machine with its disk cost about four and a half dollars a day in us-east-1, at the prices on [the load balancer’s](https://aws.amazon.com/elasticloadbalancing/pricing/), [the NAT gateway’s](https://aws.amazon.com/vpc/pricing/), [Fargate’s](https://aws.amazon.com/fargate/pricing/), [EC2’s](https://aws.amazon.com/ec2/pricing/on-demand/) and [EBS’s](https://aws.amazon.com/ebs/pricing/) pages. What agents spend at Amazon Bedrock is on top, and is whatever everyone you let in asks of them. Take it down when you’re done (“Take it down”).

## Use what you already have

The deployment is five constructs, each usable alone, and `HostedPostbox` (`lib/hosted-postbox.mjs`), which puts the five together in one scope:

| Construct | What it is | Why it is apart |
|---|---|---|
| `PostboxNetwork` (`lib/network.mjs`) | The VPC, and the security groups that say who reaches whom | Everything else stands on it, and it rarely changes |
| `PostboxData` (`lib/data.mjs`) | The disk the data folder is on | It is the one part that can’t be made again |
| `PostboxEdge` (`lib/edge.mjs`) | The load balancer, its name and certificate, and the sign-in | It stands without a server behind it |
| `PostboxAgentHost` (`lib/agent-host.mjs`) | The machine agents work on, its work disk, its role and the key the server signs in with | It is a machine with state of its own, and is replaced on its own terms |
| `PostboxServer` (`lib/server.mjs`) | The one task and its service | It changes with every release, and is the likeliest to fail to start |

`app.mjs` puts each in a stack of its own, so a part that fails rolls back alone: a server that doesn’t start leaves the network, the disk and the edge standing, and the next deployment makes only the server again. The server’s stack imports what the edge’s stack exports (the load balancer’s ARN, the client’s id, the target group), so the edge can’t rename or drop one of those while a server uses it: take the server’s stack down first. They make what they aren’t given and use what they are:

| You have | Give it | Else |
|---|---|---|
| A hosted zone | `address: { domainName, hostedZone }`: it requests the certificate, proves it through the zone and points the name at the load balancer | `address: { certificate, domainName? }`, a certificate of your own |
| An identity provider | `signIn: { userPool, userPoolDomain }` for a Cognito user pool, to which it adds one app client of its own; or `signIn: { oidc: { … } }` for any OIDC provider | a new user pool, whose people an administrator makes |
| A VPC | `vpc`, with private subnets that reach the internet | a new one: the load balancer in public subnets, Postbox in private ones behind one NAT gateway |

```js
new HostedPostbox(stack, 'Postbox', {
  source: { root: '/path/to/the/postbox/clone' },
  address: { domainName: 'postbox.example.com', hostedZone },
  signIn: { userPool, userPoolDomain },
  allow: { subjects: ['…'] },
});
```

**Signing in is not being let in.** The provider says who a person is. Who may use this Postbox is `allow`, Postbox’s own list, which Postbox checks on every request: people by their subject at the provider. A provider you share with other applications admits none of their people until you name them. `allow` is required, and until it names someone the app here leaves the server’s stack out. Admitting by a group’s claim (`allow.groups`) is only for an OIDC provider whose administrators alone set that claim; the construct refuses it for a Cognito user pool, where a claim is an attribute a person may be able to write for themselves through another of the pool’s clients. For the same reason, a person named by their email address must have one the provider verified: a provider whose userinfo doesn’t say `email_verified` must name people by another claim, so with an OIDC provider the app asks for `claimUsername` and has no default. And on a Cognito user pool shared with other applications, don’t set `claimUsername=preferred_username`: a person can write that attribute for themselves through another client, and so choose the name they are mentioned by.

## Deploy it with the app here

`app.mjs` is a small app around the construct. What is yours comes in as context: `-c name=value` on the command line, or a `cdk.context.json` in this folder, which git ignores, so your domain, your zone and your provider are never committed.

| Context | What it sets |
|---|---|
| `domainName`, `hostedZoneId`, `hostedZoneName` | The name people open, in a hosted zone of yours |
| `certificateArn` | Instead of a zone: a certificate of yours in ACM, with `domainName` when your DNS points one at the load balancer |
| `userPoolId`, `userPoolDomain` | A Cognito user pool of yours, and its sign-in domain (the prefix, or a full custom domain) |
| `oidcIssuer`, `oidcAuthorizationEndpoint`, `oidcTokenEndpoint`, `oidcUserInfoEndpoint`, `oidcClientId`, `oidcClientSecretName` | Another OIDC provider. The secret is read from Secrets Manager by its name as the stack deploys |
| `claimUsername`, `claimName` | The claims that hold a person’s user name and name. `email` and `name` with a Cognito user pool; with an OIDC provider `claimUsername` is required |
| `allowSubjects` | Who may sign in: their subjects at the provider, separated by commas. Until it is given, the server’s stack is left out |
| `allowGroupsClaim`, `allowGroups` | With an OIDC provider only: anyone in one of these groups, read from this claim |
| `agentHost` | `false` leaves the agent host out, for hosts of your own that you add in Settings › Hosts. On |
| `hostInstanceType`, `hostWorkGiB` | The machine’s size and its work disk’s. `t4g.large` and 100 |
| `hostWorkVolumeId` | A work disk kept from a machine before this one, to use instead of a new one |
| `claudeCodeVersion` | The version of Claude Code the machine installs, at its first start only. One exact version, named in `lib/agent-host.mjs`; to change it, make the machine again (“Put an agent on the host”) |
| `codexVersion` | A version of Codex to install too, at its first start only, set up for Amazon Bedrock. Left out, and not tried on a host yet |
| `hostSessionManager` | `true` lets an operator open a shell on the machine through Systems Manager. Off |
| `deletionProtection` | `false` lets the load balancer be deleted, for a test you will take down. On |
| `openTo` | The addresses that reach the listener, as a CIDR. Everywhere |
| `stackName` | The stack’s name. `PostboxTest` |

You need the AWS CLI signed in to the account, the account [bootstrapped for CDK](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) in the region, and Docker, or Finch with `CDK_DOCKER=finch` set, to build the image.

```bash
npm ci
```

```bash
npx cdk deploy --all
```

The outputs are `Url`, the address, and `LogGroup`, the server’s log. For a test with no name of your own, bring a self-signed certificate, and your browser will warn about it:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout "$TMPDIR/postbox-key.pem" -out "$TMPDIR/postbox-cert.pem" -subj "/CN=postbox-test.invalid"
```

```bash
aws acm import-certificate --certificate "fileb://$TMPDIR/postbox-cert.pem" --private-key "fileb://$TMPDIR/postbox-key.pem" --query CertificateArn --output text
```

Delete the key file once it is imported. It is written outside this folder so it is never committed.

## Let someone in

With a new user pool, the first deployment makes the pool and leaves the server out. Make the person there, with an email address marked verified, which Postbox requires; they are sent a temporary password, and set up their authenticator app at their first sign-in:

```bash
aws cognito-idp admin-create-user --user-pool-id <the pool’s id> --username <their email> --user-attributes Name=email,Value=<their email> Name=email_verified,Value=true Name=name,Value="<their name>"
```

Then read a person’s subject at the provider. For a Cognito user pool:

```bash
aws cognito-idp list-users --user-pool-id <the pool’s id> --filter 'email = "<their email>"' --query "Users[].Attributes[?Name=='sub'].Value" --output text
```

Then deploy with it in `allowSubjects`, which changes the server’s stack alone and replaces the task with one that knows them. Someone the provider signs in who isn’t on the allow list is refused by Postbox, with a message that says so.

## Put an agent on the host

The server knows the machine as `agents`: its start command writes that name, the machine’s address, its public key and the key it accepts into the server account’s SSH files (`infra/image/hosted-start.sh`). In Postbox:

1. **Settings › Hosts › +**, and name the host `agents`.
2. **Install…** on the host, which copies Postbox’s host program to it and starts its daemon ([remote-hosts.md](../designs/remote-hosts.md)).
3. **Settings › Personas**: make an agent, or edit one, on the Claude Code backend, and set where it runs to `agents`.

Its turns run on the machine, in `~/postbox-work/<its handle>` there, and call Claude through Amazon Bedrock with the machine’s role. The account needs access to Anthropic’s models in Bedrock in the deployment’s region: AWS asks for its use case form once ([model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)), and Bedrock then turns each model on at its first call, by subscribing to it in AWS Marketplace as the caller, which the machine’s role may do through Bedrock and no other way. The first turn with a model can be refused for two or three minutes while that completes, and a model your account isn’t offered stays refused.

**A project is its name.** Hosted, the form asks for no folder, since the server has none. Where a project’s agents work on the host is set in Settings › Hosts, Edit, “Project folders on this host”; left empty, each agent works in its own folder there.

**The machine is set up once, at its first start,** and says its public key to the deployment then, which is what the server knows it by. It installs nothing after that, its operating system’s updates included: making it again is how it is brought up to date. A change to its size stops and starts it in place. To make it again, with another image or a newer Claude Code: take down the server’s and the host’s stacks, which keeps the work disk, and deploy with `-c hostWorkVolumeId=<the kept volume’s id>`. The new machine finds the agents’ folders, their sessions and its SSH identity on the disk, so it is the same host to Postbox.

## What to check

- **What stands between the internet and a room,** in the order a request meets it: the load balancer signs the person in; Postbox checks the token the load balancer signed, on every request, against this load balancer, this client and this provider; and Postbox’s allow list names the person. The network rule is required: the task has no public address, and its security group admits port 8080 from the load balancer’s security group alone. Keep it so in any VPC you bring. It is what stops requests sent straight to the port with made-up key ids from using up Postbox’s key lookups and refusing sign-ins (hosted.md, “The check, whole”).
- **Why a sign-in was refused** is in the log group, one line a minute for each reason: `Postbox refused a sign-in: signer.` means the settings name another load balancer, `not-allowed` that the person isn’t on the allow list.
- **What it doesn’t do yet.** The hop from the load balancer to the task is plain HTTP inside the VPC. There is no access log, no WAF and no sign-out; a sign-in at the load balancer lasts 12 hours (`sessionTimeout`), and taking someone off the allow list is a deployment. Everyone on the allow list reaches every room, and can add an SSH host for the server to dial. An app’s `net.fetch` reaches ports 80 and 443 only.
- **What an agent on the host holds.** It runs as an account with no sudo, and can use the machine’s role, as anything on an EC2 instance can: that role may call Anthropic’s models on Bedrock, and have Bedrock subscribe the account to one at its first call, and nothing else. Everyone on the allow list shares the one machine, its account and what its agents spend (hosted.md, “What everyone on one Postbox shares”). Nothing here caps that spend: the role’s credentials work from anywhere until it is revoked, so an agent that sent them out would leave someone else calling models on your account. The host’s Bedrock access isn’t limited to the VPC. Name the models with the construct’s `models`, and set a budget alarm of your own.
- **What an agent can do to its own host.** Whatever runs on the machine can say its identity to the deployment again, differently, and the next update of the host’s stack keeps what was said last. The server reads it as untrusted: one that isn’t a single ed25519 key sets up no host, with a line in the server’s log, and a false key gets a host the server refuses to talk to. Neither reaches another host or the server’s data; making the machine again puts it right.
- **What still leans on the network for the host.** Its security group lets it out on ports 443, 80 and 22 to anywhere, the VPC’s own addresses included: in a VPC of yours, an agent reaches whatever there admits the VPC’s addresses. And everything the host says to the server comes from an account agents run as, so the server treats it as it treats any host’s daemon ([remote-hosts.md](../designs/remote-hosts.md)).
- **One writer.** The service runs one task and stops it before starting its replacement, so a deployment drops every page’s stream for a moment and pages reconnect. Never raise the task count: a second task would take over the data folder’s lock while the first still writes (hosted.md, “One server, one disk”).

## Take it down

```bash
npx cdk destroy --all
```

The data folder’s file system is kept, and so are the agent host’s work disk and a user pool the stack made, so that taking a deployment down loses no one’s rooms or accounts by accident: delete them yourself when you mean to. A certificate you imported stays in ACM until you delete it there.
