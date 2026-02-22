FROM node:20-alpine AS builder
WORKDIR /app
COPY apps/kb/app/package.json apps/kb/app/package-lock.json* ./
RUN npm install
COPY apps/kb/app/ ./
RUN npx ng build --configuration=production && node build.mjs

FROM nginx:alpine
COPY --from=builder /app/dist/kb-app.js /usr/share/nginx/html/kb-app.js
RUN printf 'server {\n    listen 8093;\n    location / {\n        root /usr/share/nginx/html;\n        add_header Access-Control-Allow-Origin *;\n        add_header Content-Type application/javascript;\n        add_header Cache-Control no-cache;\n    }\n    location /health {\n        return 200 "ok";\n    }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 8093
