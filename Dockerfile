# Static site: nginx serves public/ as-is, no build step. Runs as an unprivileged user on port 8080.
# The digest pins the exact image; Dependabot proposes updates.
FROM nginxinc/nginx-unprivileged:1.30-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY public/ /usr/share/nginx/html/
EXPOSE 8080
