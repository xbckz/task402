FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts
COPY src ./src
COPY container ./container
RUN useradd --create-home --uid 10001 parser && chown -R parser:parser /app
USER parser
EXPOSE 8080
CMD ["node", "--import", "tsx/esm", "container/server.ts"]
