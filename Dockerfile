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

# The build shown in the sidebar: an image has no clone to read the commit from (server/build-info.mjs).
ARG POSTBOX_COMMIT=
ENV POSTBOX_COMMIT=$POSTBOX_COMMIT NODE_ENV=production

# The data folder is a volume the deployment attaches: a container’s own disk is lost with it.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

# The deployment mounts the settings file, or overrides this command to write one (infra/lib/server.mjs).
CMD ["node", "bin/postbox.mjs", "--hosted", "/etc/postbox/hosted.json", "--data", "/data", "--port", "8080"]
