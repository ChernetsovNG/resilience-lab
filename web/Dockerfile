FROM node:26.12.1-alpine AS build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM nginx:alpine
COPY --from=build /web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/nginx.conf
USER nginx
EXPOSE 8080
