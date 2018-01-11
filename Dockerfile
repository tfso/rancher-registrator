FROM node:8.9-alpine

WORKDIR /agent

COPY index.js .
COPY package.js .

RUN npm install --production

ENTRYPOINT ["npm start"]