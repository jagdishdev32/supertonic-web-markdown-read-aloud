# Local Supertonic TTS server, pinned to the exact versions the extension
# ships in supertonic-server-requirements.lock.txt (supertonic 1.3.1).
# First `serve` start downloads the model (~260 MB) into /root/.cache —
# keep the compose volume so that happens once.
FROM python:3.12-slim
WORKDIR /srv
COPY supertonic-server-requirements.lock.txt ./
RUN pip install --no-cache-dir -r supertonic-server-requirements.lock.txt
EXPOSE 7788
CMD ["supertonic", "serve", "--host", "0.0.0.0", "--port", "7788"]
