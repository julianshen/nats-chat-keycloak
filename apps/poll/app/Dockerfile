FROM node:20-alpine AS builder
WORKDIR /app
COPY apps/poll/app/package.json apps/poll/app/package-lock.json* ./
RUN npm install
COPY apps/poll/app/src ./src
COPY apps/poll/app/tsconfig.json apps/poll/app/vite.config.ts ./
RUN npm run build

FROM nginx:alpine

RUN mkdir -p /usr/share/nginx/html

COPY --from=builder /app/dist/poll-app.js /usr/share/nginx/html/poll-app.js

RUN printf 'server {\n\
    listen 8091;\n\
    location / {\n\
        root /usr/share/nginx/html;\n\
        add_header Access-Control-Allow-Origin *;\n\
        add_header Content-Type application/javascript;\n\
    }\n\
    location /health {\n\
        return 200 "ok";\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 8091
