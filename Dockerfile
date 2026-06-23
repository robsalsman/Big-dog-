# Big Dog — production image.
# Runs the app with tsx (no build step), same as `npm start`.
FROM node:22-bookworm-slim

# better-sqlite3 compiles a native addon on install — needs a toolchain + python.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Install deps first for layer caching. We need devDependencies too (tsx,
# typescript) because the app runs straight from TypeScript via tsx.
COPY package.json package-lock.json* ./
RUN npm install --include=dev

# App source.
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
# config/ holds accounts.json (gitignored) + the example; mount the real one at
# runtime via a volume. Copy whatever exists so the example ships in the image.
COPY config ./config

# Mail cache / deals / calendar live here — mount a volume to persist them.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 4137
CMD ["npm", "start"]
