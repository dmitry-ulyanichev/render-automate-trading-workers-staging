FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

RUN mkdir -p data/queues data/logs logs /home/appuser/.local \
    && chown -R 33:33 /home/appuser /app/data

ENV HOME=/home/appuser

CMD ["node", "main.js"]
