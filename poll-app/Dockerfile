FROM nginx:alpine

RUN mkdir -p /usr/share/nginx/html

COPY poll-app/poll-app.js /usr/share/nginx/html/poll-app.js

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
