# The server’s image for a hosted Postbox (designs/architecture/hosted.md, “The test deployment on AWS”). It carries
# Postbox and an SSH client to reach agent hosts with, and no agent CLI: hosted agents run on hosts. Postbox has no
# dependencies to install, so the image is Node and the folders that run.
FROM node:24-bookworm-slim

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

# The deployment mounts the settings file, or overrides this command to write one (infra/lib/postbox-stack.mjs).
CMD ["node", "bin/postbox.mjs", "--hosted", "/etc/postbox/hosted.json", "--data", "/data", "--port", "8080"]
