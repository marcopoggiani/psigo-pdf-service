# PsiGo PDF Service: reproducible Node runtime with local OCR binaries.
# Keep PDF_SERVICE_SECRET and other credentials in Render environment, not here.
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    OMP_THREAD_LIMIT=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       poppler-utils tesseract-ocr tesseract-ocr-ita tesseract-ocr-eng ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ocr.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
