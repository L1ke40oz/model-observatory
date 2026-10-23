FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs sites.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node lib ./lib
USER node
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
