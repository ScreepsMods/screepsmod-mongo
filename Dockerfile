FROM node:6.10
WORKDIR /app
RUN yarn global add screeps
CMD ["screeps","start"]