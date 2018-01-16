FROM node:8.9-alpine

WORKDIR /agent

COPY index.js .
COPY package.json .

RUN npm install --production

CMD ["npm", "start"]