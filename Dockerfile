# syntax=docker/dockerfile:1.7

# The dashboard is a static application. Nginx serves the compiled site and
# provides a small health endpoint for Docker orchestration.
FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="Mama Africa Transport" \
      org.opencontainers.image.description="Static transport operations dashboard for Uganda"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html fuel-prices.json LOGO.jpg /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1/healthz || exit 1

STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
