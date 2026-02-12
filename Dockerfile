# Dockerfile

FROM node:20-bookworm-slim

RUN mkdir -p /app/data

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Ookla (real CLI)
RUN curl -s https://packagecloud.io/install/repositories/ookla/speedtest-cli/script.deb.sh | bash \
    && apt-get update \
    && apt-get install -y --no-install-recommends speedtest \
    && rm -rf /var/lib/apt/lists/*

# Verify Ookla is real
RUN /usr/bin/speedtest --version | grep -i -E "ookla|speedtest by ookla"

# python speedtest-cli (pip)
RUN pip3 install --no-cache-dir speedtest-cli --break-system-packages

# IMPORTANT: remove the pip-created "speedtest" shim if it exists
RUN rm -f /usr/local/bin/speedtest || true

WORKDIR /app
CMD ["node", "stats-api.js"]
