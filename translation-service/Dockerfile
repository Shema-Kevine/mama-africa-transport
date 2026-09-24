FROM node:22-alpine

WORKDIR /app
COPY server.js /app/server.js

ENV NODE_ENV=production
USER node
EXPOSE 3001

CMD ["node", "server.js"]
