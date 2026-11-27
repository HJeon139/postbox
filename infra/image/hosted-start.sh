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
#   POSTBOX_HOST_ALIAS     the name the host is added by in Settings › Hosts; agents
set -eu
umask 077
printf '%s' "$POSTBOX_HOSTED" > "$HOME/hosted.json"

if [ -n "${POSTBOX_HOST_KEY:-}" ]; then
  alias_name=${POSTBOX_HOST_ALIAS:-agents}
  # One key on one line, and an address that is one: each becomes a line of a file ssh trusts, so anything else in
  # them would be a line of its own there.
  nl='
'
  case "$POSTBOX_HOST_IDENTITY$POSTBOX_HOST_ADDRESS$alias_name" in *"$nl"*) echo "The agent host’s identity, address or name has more than one line." >&2; exit 1 ;; esac
  printf '%s' "$POSTBOX_HOST_IDENTITY" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+$' || { echo "The agent host’s identity isn’t an ed25519 public key." >&2; exit 1; }
  printf '%s' "$POSTBOX_HOST_ADDRESS$alias_name" | grep -Eq '^[A-Za-z0-9.:-]+$' || { echo "The agent host’s address or name has a character neither uses." >&2; exit 1; }
  mkdir -p "$HOME/.ssh"
  printf '%s\n' "$POSTBOX_HOST_KEY" > "$HOME/.ssh/agent-host"
  # The host is known by its key and no other: Postbox’s ssh refuses a host whose key isn’t here (server/remote/ssh-args.mjs).
  printf '%s %s\n' "$alias_name" "$POSTBOX_HOST_IDENTITY" > "$HOME/.ssh/known_hosts"
  cat > "$HOME/.ssh/config" <<CONFIG
Host $alias_name
  HostName $POSTBOX_HOST_ADDRESS
  HostKeyAlias $alias_name
  User postbox
  IdentityFile $HOME/.ssh/agent-host
  IdentitiesOnly yes
CONFIG
fi
unset POSTBOX_HOSTED POSTBOX_HOST_KEY POSTBOX_HOST_ADDRESS POSTBOX_HOST_IDENTITY POSTBOX_HOST_ALIAS

exec node bin/postbox.mjs --hosted "$HOME/hosted.json" --data /data --port "${POSTBOX_PORT:-8080}"
