# Why this file exists
#
# MinIO's own images stopped being publicly pullable: quay.io/minio/minio issues an
# anonymous token but then refuses the manifest (401), Docker Hub's minio/minio denies
# anonymous pulls, and bitnami/minio is gone. CI could not pull it, and neither can a
# fresh clone, so `docker compose up` would fail for a new developer.
#
# This mirrors the last image we hold into the project's own registry. It is only the
# local development and test S3 server — production uses a real S3-compatible service
# through the storage adapter, so nothing here ships.
#
# The LABEL is load-bearing: GHCR uses org.opencontainers.image.source to link the
# package to the repository, which is what lets CI pull it with GITHUB_TOKEN and
# `packages: read` instead of a separate registry secret.
#
# Rebuild and publish (needs the base image in the local cache and write:packages):
#   docker build -f deploy/minio-mirror.Dockerfile -t ghcr.io/rishu358/crm-minio:RELEASE.2025-09-07T16-13-09Z .
#   docker push ghcr.io/rishu358/crm-minio:RELEASE.2025-09-07T16-13-09Z
#
# Known limitation: the cached base is linux/amd64 only, so this mirror is single
# platform. GitHub's runners are amd64, but an arm64 machine (Apple Silicon) cannot
# use it as is and will need its own mirror built from an arm64 base.

FROM quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e

LABEL org.opencontainers.image.source=https://github.com/rishu358/CRM
LABEL org.opencontainers.image.description="Mirror of MinIO RELEASE.2025-09-07T16-13-09Z for local development and CI, because upstream is no longer publicly pullable."
