FROM microsoft/nanoserver

RUN @powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))" && SET "PATH=%PATH%;%ALLUSERSPROFILE%\chocolatey\bin"
RUN choco upgrade chocolatey
RUN choco install -y nodejs --version 8.9.1

WORKDIR /agent

COPY . .

RUN npm install --production

CMD ["node", "index.js"]