FROM microsoft/nanoserver

ADD https://nodejs.org/dist/v8.9.1/node-v8.9.1-win-x64.zip C:\\build\\node-v8.9.1-win-x64.zip

RUN @powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference = 'SilentlyContinue'; Expand-Archive C:\build\node-v8.9.1-win-x64.zip C:\; Rename-Item C:\node-v8.9.1-win-x64 node"
RUN SETX PATH C:\node

WORKDIR /agent

COPY ./ .

RUN dir

RUN npm install --production

CMD ["node", "index.js"]