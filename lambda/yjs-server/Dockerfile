FROM public.ecr.aws/docker/library/node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

# The pinned base can lag Alpine's security fixes, so apply the ones the
# release repository already has.
RUN apk upgrade --no-cache

WORKDIR /app

COPY --chown=node:node --chmod=0644 yjs-server/package.json yjs-server/package-lock.json ./
# npm is only needed to install the dependencies. Removing it keeps the
# packages it bundles, and their CVEs, out of the runtime image.
RUN npm ci --omit=dev \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --chown=node:node --chmod=0644 shared/space-permissions.js shared/space-membership.js shared/business-roles.js shared/business-role-catalog.json shared/realtime-token.js ./shared/
COPY --chown=node:node --chmod=0644 shared/policies/space.cedar ./shared/policies/
COPY --chown=node:node --chmod=0644 yjs-server/*.js ./yjs-server/

RUN chmod 0755 /app/shared /app/shared/policies /app/yjs-server

WORKDIR /app/yjs-server

# Optional OS package refresh (Terraform os_packages_epoch). A local build
# cache keeps the upgrade layer above from its first build; a new epoch reruns
# only this last layer. Without an epoch (CI and pre-built images) the step
# does nothing.
ARG OS_PACKAGES_EPOCH=""
RUN if [ -n "${OS_PACKAGES_EPOCH}" ]; then \
        echo "Refreshing OS packages for epoch ${OS_PACKAGES_EPOCH}" \
        && apk upgrade --no-cache; \
    fi
LABEL aidlc.os-packages-epoch="${OS_PACKAGES_EPOCH}"

USER node

EXPOSE 1234

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://localhost:1234/livez || exit 1

CMD ["node", "server.js"]
