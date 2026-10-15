# syntax=docker/dockerfile:1.7
# One image, two entrypoints: the API (default) and the worker (`node dist/worker.js`).

# --- Rust helper: sandboxed DOCX extraction -------------------------------
FROM rust:1-slim AS rust
WORKDIR /src
COPY rust/doc-tools/Cargo.toml rust/doc-tools/Cargo.lock* ./
COPY rust/doc-tools/src ./src
RUN cargo build --release && strip target/release/pn-doc-tools

# --- Node build ------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY scripts/build-schema.mjs scripts/db-setup.cjs ./scripts/
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- Runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production DOC_TOOLS_BIN=/usr/local/bin/pn-doc-tools PORT=8000
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /app app
COPY --from=rust /src/target/release/pn-doc-tools /usr/local/bin/pn-doc-tools
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY scripts/db-setup.cjs ./scripts/db-setup.cjs
COPY package.json ./
USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
