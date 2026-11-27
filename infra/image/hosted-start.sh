#!/bin/sh
# Starts Postbox in the server’s container of a hosted deployment (infra/lib/server.mjs). What the deployment knows
# reaches a container as environment variables, and Postbox and ssh read files, so this writes the files, in the one
# folder the container can write, and then starts Postbox without the variables: a key in the environment would be
# inherited by everything Postbox starts.
#
#   POSTBOX_HOSTED         Postbox’s hosted settings, as JSON (server/hosted-settings.mjs)
#   POSTBOX_HOST_KEY       the private key the agent host accepts; left out, no host is set up
#   POSTBOX_HOST_ADDRESS   the agent host’s address
#   POSTBOX_HOST_IDENTITY  the agent host’s public key, which ssh checks it by
set -eu
umask 077
printf '%s' "$POSTBOX_HOSTED" > "$HOME/hosted.json"

# The name the host is added by in Settings › Hosts (infra/README.md, “Put an agent on the host”).
name=agents

# Why the host’s address and identity can’t be written to ssh’s files, or nothing when they can. Each becomes a line
# of a file ssh trusts, so each must be one line of its own kind: anything more would be a line of its own there,
# such as a key for every host. The identity is what the machine said at its first start, which whatever runs there
# since can say again differently (infra/lib/agent-host.mjs), so it is read as untrusted.
unfit() {
  nl='
'
  case "$POSTBOX_HOST_IDENTITY$POSTBOX_HOST_ADDRESS" in *"$nl"*) echo "has more than one line" && return ;; esac
  printf '%s' "$POSTBOX_HOST_IDENTITY" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+$' || { echo "isn’t one ed25519 public key" && return; }
  printf '%s' "$POSTBOX_HOST_ADDRESS" | grep -Eq '^[A-Za-z0-9.:-]+$' || echo "has an address with a character none uses"
}

if [ -n "${POSTBOX_HOST_KEY:-}" ]; then
  why=$(unfit)
  if [ -n "$why" ]; then
    # Postbox still starts: people keep their rooms, and the host shows as one it can’t reach until this is put right.
    echo "The agent host’s identity or address $why, so the host “$name” isn’t set up. Make the machine again (infra/README.md)." >&2
  else
    mkdir -p "$HOME/.ssh"
    printf '%s\n' "$POSTBOX_HOST_KEY" > "$HOME/.ssh/agent-host"
    # The host is known by its key and no other: Postbox’s ssh refuses a host whose key isn’t here (server/remote/ssh-args.mjs).
    printf '%s %s\n' "$name" "$POSTBOX_HOST_IDENTITY" > "$HOME/.ssh/known_hosts"
    cat > "$HOME/.ssh/config" <<CONFIG
Host $name
  HostName $POSTBOX_HOST_ADDRESS
  HostKeyAlias $name
  User postbox
  IdentityFile $HOME/.ssh/agent-host
  IdentitiesOnly yes
CONFIG
  fi
fi
unset POSTBOX_HOSTED POSTBOX_HOST_KEY POSTBOX_HOST_ADDRESS POSTBOX_HOST_IDENTITY

exec node bin/postbox.mjs --hosted "$HOME/hosted.json" --data /data --port "${POSTBOX_PORT:-8080}"
