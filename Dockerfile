FROM node:14.15.4-alpine

ARG SOURCE_COMMIT
LABEL maintainer="Tim Roes <tim.roes@elastic.co>"
LABEL source="https://github.com/elastic/issue-crawler"
LABEL source-commit="${SOURCE_COMMIT:-unknown}"

RUN mkdir -p /code
WORKDIR /code
ADD . /code
RUN yarn install && \
    yarn cache clean

ENTRYPOINT ["yarn"]
CMD [ "start" ]
