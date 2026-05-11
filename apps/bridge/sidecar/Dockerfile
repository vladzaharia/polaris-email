FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN apk add --no-cache git && \
    npm install --omit=dev --no-audit --no-fund && \
    npm install --no-save --no-audit --no-fund typescript && \
    ./node_modules/.bin/tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
