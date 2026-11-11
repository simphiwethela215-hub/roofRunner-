FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY earnbox ./earnbox
EXPOSE 3000
CMD ["npm", "start"]
