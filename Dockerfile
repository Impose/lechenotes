FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
RUN cp node_modules/sortablejs/Sortable.min.js public/sortable.min.js 2>/dev/null || true
COPY . .
RUN cp node_modules/sortablejs/Sortable.min.js public/sortable.min.js
RUN mkdir -p /data
EXPOSE 3333
CMD ["node", "server.js"]
