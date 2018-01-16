FROM node:8.9-alpine

WORKDIR /agent

COPY . .

RUN npm install --production

CMD ["npm", "start"]