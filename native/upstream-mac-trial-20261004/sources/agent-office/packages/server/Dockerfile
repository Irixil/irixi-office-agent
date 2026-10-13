FROM node:18-alpine
WORKDIR /app

# Copy workspace root
COPY package.json package-lock.json tsconfig.base.json ./

# Copy all packages (needed for workspace resolution)
COPY packages/ packages/

# Install dependencies
RUN npm install --production=false

# Build all packages in dependency order
RUN npm run build --workspace=@agent-office/core && \
    npm run build --workspace=@agent-office/adapters && \
    npm run build --workspace=@agent-office/server

EXPOSE 3000

CMD ["npm", "run", "start", "--workspace=@agent-office/server"]
