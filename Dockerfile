# =====================================================================
# Matrix LMS — Backend Dockerfile (multi-stage build)
# =====================================================================

# ---- Stage 1: install production dependencies only ------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- Stage 2: runtime -------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Reuse the node:alpine image's built-in unprivileged "node" user
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# /app/public is where docker-compose bind-mounts ../frontend (read-only)
RUN mkdir -p /app/public && chown -R node:node /app
USER node

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||4000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
