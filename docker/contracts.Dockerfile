# Local chain and deployer, for the "local" compose profile and CI smoke tests.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY contracts/package.json contracts/package.json
COPY web/package.json web/package.json
RUN npm ci -w @weekend-options/contracts --include-workspace-root=false
COPY contracts contracts
RUN npx --prefix contracts hardhat compile --config contracts/hardhat.config.js
EXPOSE 8545
CMD ["npm", "run", "node", "-w", "@weekend-options/contracts"]
