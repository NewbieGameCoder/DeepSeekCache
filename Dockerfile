FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json tsup.config.ts vitest.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY --from=build /app/dist ./dist
EXPOSE 48731 11488
VOLUME ["/workspace", "/data"]
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve", "--project", "/workspace", "--data-dir", "/data", "--host", "0.0.0.0"]
