FROM oven/bun:1 AS builder

WORKDIR /usr/src/app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .
RUN bunx prisma generate --config prisma/prisma.config.ts

FROM oven/bun:1

ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY --from=builder /usr/src/app ./

USER bun

EXPOSE 3780

# Liveness probe via Bun's built-in fetch (no curl in the lean oven/bun image). Hits /health, which is a
# cheap always-200 check that never touches the DB, so a wedged dependency can't bounce a live instance.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:3780/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "index.ts"]
