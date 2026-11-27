# The server’s image for a hosted Postbox (designs/architecture/hosted.md, “The test deployment on AWS”). It carries
# Postbox and an SSH client to reach agent hosts with, and no agent CLI: hosted agents run on hosts. Postbox has no
# dependencies to install, so the image is Node and the folders that run.
# Pinned by digest, so a rebuild is the same image until this line changes.
FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/postbox
COPY package.json CHANGELOG.md ./
COPY bin bin
COPY app app
COPY server server
COPY shared shared
COPY agent-plugin agent-plugin
# How a deployment starts it: its settings and its agent host’s SSH files written from the environment, then Postbox.
COPY --chmod=0755 infra/image/hosted-start.sh /usr/local/bin/postbox-hosted-start

# The build shown in the sidebar: an image has no clone to read the commit from (server/build-info.mjs).
ARG POSTBOX_COMMIT=
ENV POSTBOX_COMMIT=$POSTBOX_COMMIT NODE_ENV=production

# The two places Postbox writes, each a volume owned by the user it runs as, so the rest of the disk can be read-only:
# the data folder, which the deployment attaches because a container’s own disk is lost with it, and a scratch folder
# for its settings file and temporary files.
# The scratch folder is also the user’s home, since ssh finds its files by the account’s home and not by $HOME.
RUN mkdir /data /run/postbox && chown node:node /data /run/postbox && usermod --home /run/postbox node
USER node
VOLUME ["/data", "/run/postbox"]
ENV HOME=/run/postbox TMPDIR=/run/postbox
EXPOSE 8080

# The deployment mounts the settings file, or runs postbox-hosted-start instead, which writes one (infra/lib/server.mjs).
CMD ["node", "bin/postbox.mjs", "--hosted", "/etc/postbox/hosted.json", "--data", "/data", "--port", "8080"]
