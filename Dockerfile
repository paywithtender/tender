FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY contracts/package.json ./contracts/package.json
RUN npm ci --workspace packages/facilitator --workspace packages/sdk --include-workspace-root
ENV DATA_DIR=/data
EXPOSE 4021
CMD ["npx", "tsx", "packages/facilitator/src/server.ts"]
