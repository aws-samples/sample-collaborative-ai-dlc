FROM public.ecr.aws/docker/library/node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

# The pinned base can lag Alpine's security fixes, so apply the ones the
# release repository already has.
RUN apk upgrade --no-cache

WORKDIR /app

COPY --chown=node:node --chmod=0644 package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node --chmod=0644 server.js service.js rooms.js protocol.js cluster.js aws-store.js config.js doc-name.js realtime-token.js ./

USER node

EXPOSE 1234

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://localhost:1234/livez || exit 1

CMD ["node", "server.js"]
