# Workroom sandbox image: python3 + node + common data/document libraries. Built once, used for every sandbox run
# (`docker build -t workroom/sandbox:1 server/sandbox`, or `node server/sandbox/build-image.mjs`). Nothing here runs at
# container start: Workroom starts each run with --read-only, --network none, a non-root user and all capabilities dropped.
#
# Bases are pinned by digest (python 3.12-slim and node 22-slim, 2026-11-09). To bump: docker pull both tags, copy the new
# digests here and into server/src/tools/sandbox/docker.ts (FALLBACK_*_IMAGE), rebuild, bump the image tag (workroom/sandbox:2).
FROM node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS node

FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

# Node.js runtime (binary + npm) copied from the official image: no apt repositories, no curl | sh.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# CJK fonts so charts and PDFs with Chinese text render; poppler/tesseract-free on purpose (keep the image small).
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-wqy-microhei fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Common data / document libraries (wheels only, no compilers in the image).
# Behind a corporate proxy or in mainland China pass a mirror: --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
# (pip reads these build args as its own PIP_INDEX_URL / PIP_TRUSTED_HOST environment variables during this step only).
ARG PIP_INDEX_URL
ARG PIP_TRUSTED_HOST
RUN pip install --no-cache-dir --only-binary=:all: \
      numpy pandas scipy matplotlib openpyxl xlsxwriter python-docx python-pptx pypdf pillow \
      pyyaml beautifulsoup4 lxml tabulate requests

# Matplotlib: headless backend + the CJK font above as the default sans-serif fallback.
ENV MPLBACKEND=Agg \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LANG=C.UTF-8

# A non-root user for hosts that do not override --user (Workroom passes --user explicitly).
RUN useradd --uid 10001 --create-home --shell /bin/sh sandbox
USER 10001:10001
WORKDIR /work
