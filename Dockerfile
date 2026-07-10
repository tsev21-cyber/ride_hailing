# Tylo — one always-on service: dispatch engine + Socket.IO gateway + web app.
# Deploys anywhere that runs a container (Render, Railway, Fly.io, a VPS).
FROM node:22-alpine

WORKDIR /app

# Install with the full workspace context so @tylo/shared is linked, then build
# in order (shared -> server -> web) via the root build script.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
# Hosts inject their own PORT; main.ts reads process.env.PORT and binds 0.0.0.0.
ENV PORT=4000
EXPOSE 4000

CMD ["node", "server/dist/main.js"]
