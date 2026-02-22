FROM node:20-alpine AS builder
WORKDIR /app
COPY apps/whiteboard/service/package.json apps/whiteboard/service/package-lock.json* ./
RUN npm install
COPY apps/whiteboard/service/src ./src
COPY apps/whiteboard/service/tsconfig.json ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist

ENTRYPOINT ["node", "dist/index.js"]
