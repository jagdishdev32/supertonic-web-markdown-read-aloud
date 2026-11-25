# Read Aloud web app — engines and reader UI prebundled; no build step in-container.
# host.cjs is committed, so only runtime deps install (msedge-tts's pnpm-only
# preinstall gate is skipped with --ignore-scripts; no native code involved).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY host.cjs server.mjs vscode-stub.ts ./
COPY public public
COPY media media
ENV HOST=0.0.0.0
EXPOSE 7789
CMD ["node", "server.mjs"]
