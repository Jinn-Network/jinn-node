# Build context should be the monorepo root:
# docker build -f jinn-node/Dockerfile -t jinn-node .

FROM node:22-alpine

WORKDIR /app

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++ git

# Copy root package files for workspace resolution
COPY package.json yarn.lock ./
COPY jinn-node/package.json ./jinn-node/

# Install dependencies
RUN yarn install --frozen-lockfile --production=false

# Copy jinn-node source and assets
COPY jinn-node/src/ ./jinn-node/src/
COPY jinn-node/tsconfig.json jinn-node/tsconfig.build.json ./jinn-node/

# Build TypeScript
WORKDIR /app/jinn-node
RUN yarn build

# Set environment
ENV NODE_ENV=production

# Set entrypoint
ENTRYPOINT ["node", "dist/worker/mech_worker.js"]
