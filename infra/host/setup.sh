#!/bin/bash
# Makes a Linux machine an agent host for a hosted Postbox (designs/architecture/hosted.md, “What runs an agent
# host, weighed”): Node, git and the agent CLIs, one account that agents work as, and an SSH server that admits one
# key and keeps one identity. It is written apart from the construct that runs it (infra/lib/agent-host.mjs), for
# Amazon Linux 2023, so the same steps can build an image when a team wants the host as a pod.
#
# What it reads from the environment:
#   POSTBOX_WORK_DEVICE   the block device of the work disk, such as /dev/sdf; left out, the root disk holds the work
#   POSTBOX_SERVER_KEY    the public key the Postbox server signs in with, one line
#   POSTBOX_REGION        the region the agents’ models are called in
#   POSTBOX_CLAUDE_CODE   the version of Claude Code to install, such as 2.1.259 or latest
#   POSTBOX_CODEX         the version of Codex to install; left out, Codex isn’t installed
# What it prints last, alone on a line: the host’s public key, for the server’s known_hosts.
set -euo pipefail

ACCOUNT=postbox
MOUNT=/mnt/postbox
KEYS="$MOUNT/host-keys"

# The work disk: everything an agent leaves behind, and the host’s own identity, so that a replaced machine is the
# same host to Postbox, with its agents’ folders, sessions and the daemon’s records where they were.
mkdir -p "$MOUNT"
if [ -n "${POSTBOX_WORK_DEVICE:-}" ]; then
  for _ in $(seq 1 120); do [ -b "$POSTBOX_WORK_DEVICE" ] && break; sleep 2; done
  [ -b "$POSTBOX_WORK_DEVICE" ] || { echo "The work disk $POSTBOX_WORK_DEVICE never appeared." >&2; exit 1; }
  # A new disk has no file system. One that has is the last machine’s, and is kept as it is.
  blkid "$POSTBOX_WORK_DEVICE" >/dev/null 2>&1 || mkfs.xfs -q "$POSTBOX_WORK_DEVICE"
  echo "UUID=$(blkid -s UUID -o value "$POSTBOX_WORK_DEVICE") $MOUNT xfs defaults,nofail 0 2" >> /etc/fstab
  mount "$MOUNT"
fi

dnf install -y -q nodejs22 nodejs22-npm git tar gzip openssh-server
# Amazon Linux installs each Node beside the others, as node-22; `node` and `npm` are what Postbox’s daemon and the
# CLIs look for.
alternatives --set node /usr/bin/node-22
npm install --global --silent "@anthropic-ai/claude-code@${POSTBOX_CLAUDE_CODE:-latest}"
if [ -n "${POSTBOX_CODEX:-}" ]; then npm install --global --silent "@openai/codex@$POSTBOX_CODEX"; fi

# The account agents work as: no password, no sudo, its home on the work disk.
id "$ACCOUNT" >/dev/null 2>&1 || useradd -u 1500 -M -d "$MOUNT/home" -s /bin/bash "$ACCOUNT"
install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 0700 "$MOUNT/home"
# One key, the server’s, and only for commands: no forwarding of any kind and no terminal, which Postbox never asks
# for. It is root’s file, outside the account’s home, so an agent can’t add a key or lift the limit.
printf 'restrict %s\n' "$POSTBOX_SERVER_KEY" > /etc/ssh/postbox_keys
chmod 0644 /etc/ssh/postbox_keys

# The models are Amazon Bedrock’s, reached with the machine’s own role: no key is written anywhere. sshd gives a
# session these through pam_env, whatever shell or command it runs.
cat > /etc/environment <<EOF
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=$POSTBOX_REGION
EOF
if [ -n "${POSTBOX_CODEX:-}" ]; then
  install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 0700 "$MOUNT/home/.codex"
  [ -e "$MOUNT/home/.codex/config.toml" ] || printf 'model_provider = "amazon-bedrock"\n' > "$MOUNT/home/.codex/config.toml"
  chown "$ACCOUNT:$ACCOUNT" "$MOUNT/home/.codex/config.toml"
fi

# The host’s identity, made once and kept on the work disk, root’s alone.
install -d -m 0700 "$KEYS"
[ -e "$KEYS/ssh_host_ed25519_key" ] || ssh-keygen -q -t ed25519 -N '' -C postbox-agent-host -f "$KEYS/ssh_host_ed25519_key"
cat > /etc/ssh/sshd_config.d/10-postbox.conf <<EOF
HostKey $KEYS/ssh_host_ed25519_key
AllowUsers $ACCOUNT
AuthorizedKeysFile /etc/ssh/postbox_keys
# Amazon Linux asks EC2 Instance Connect for keys too, which would admit anyone in the account who may send one.
AuthorizedKeysCommand none
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
DisableForwarding yes
PermitTTY no
PermitUserRC no
EOF
sshd -t
systemctl enable --quiet sshd
systemctl restart sshd

cut -d' ' -f1,2 "$KEYS/ssh_host_ed25519_key.pub"
