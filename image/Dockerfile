# KubeOS dashboard image.
#
# Deliberately ONE layer on the official Headlamp image. The upstream binary and
# frontend bundle are untouched, which buys three things:
#   * a KubeOS bug can never be a Headlamp bug;
#   * upstream security releases are an ARG bump, not a merge;
#   * no Go/Node toolchain in the image or in the build.
#
# The plugin is dropped where headlamp-server already looks:
#   ENTRYPOINT ["/headlamp/headlamp-server", "-html-static-dir", "/headlamp/frontend",
#               "-plugins-dir", "/headlamp/plugins"]
#
# Build from the repository root:
#   docker build -f image/Dockerfile -t ghcr.io/skmdab/headlamp:kubeos-0.1.0 .
ARG HEADLAMP_VERSION=v0.46.0
FROM ghcr.io/headlamp-k8s/headlamp:${HEADLAMP_VERSION}

# Prebuilt by `npm run build` in kubeos-branding/ (package.json + main.js).
#
# --chmod=644 is not cosmetic: the server runs as the unprivileged `headlamp`
# user, and a file that lands mode 600 is served as 403, which makes the
# frontend reject the plugin silently.
COPY --chmod=644 kubeos-branding/dist/ /headlamp/plugins/kubeos-branding/
