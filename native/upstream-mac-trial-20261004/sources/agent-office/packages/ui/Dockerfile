# Build stage
FROM node:18-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ packages/

RUN npm install --production=false

RUN npm run build --workspace=@agent-office/core && \
    npm run build --workspace=@agent-office/adapters && \
    npm run build --workspace=@agent-office/ui

# Serve stage
FROM nginx:alpine
COPY --from=build /app/packages/ui/dist /usr/share/nginx/html
COPY packages/ui/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
