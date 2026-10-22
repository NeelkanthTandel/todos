# Static site: nginx serves public/ as-is, no build step. Runs as an unprivileged user on port 8080.
# The digest pins the exact image; Dependabot proposes updates.
FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY public/ /usr/share/nginx/html/
EXPOSE 8080
