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

# Optional: Vercel Labs agent-browser + headless Chrome, so Big Dog can read
# JS-rendered web pages for lead research. Build-safe — if the download is
# blocked the image still builds and the app runs without it. Disable with
# `--build-arg WITH_BROWSER=false`.
ARG WITH_BROWSER=true
RUN if [ "$WITH_BROWSER" = "true" ]; then \
      npm install -g agent-browser \
      && agent-browser install --with-deps \
      || echo "[big-dog] agent-browser install skipped (continuing without live browser)"; \
    fi

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
