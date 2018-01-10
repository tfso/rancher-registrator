FROM node:8.9-alpine

ADD . /agent

RUN npm install --production

ENTRYPOINT ["npm start"]