FROM node:22-alpine

WORKDIR /app

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++ git

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile --production=false

# Copy source and assets
COPY src/ ./src/
COPY abis/ ./abis/
COPY tsconfig.json tsconfig.build.json ./

# Build TypeScript
RUN yarn build

# Set environment
ENV NODE_ENV=production

# Set entrypoint
ENTRYPOINT ["node", "dist/worker/mech_worker.js"]
