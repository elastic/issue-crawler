#!/bin/sh

export ES_HOST=$(vault read -field host secret/ci/elastic-issue-crawler/github-stats-user)
export ES_USER=$(vault read -field user secret/ci/elastic-issue-crawler/github-stats-user)
export ES_PASSWORD=$(vault read -field password secret/ci/elastic-issue-crawler/github-stats-user)
export GITHUB_OAUTH_APP_ID=$(vault read -field app_id secret/ci/elastic-issue-crawler/github_oauth_app)
export GITHUB_OAUTH_INSTALLATION_ID=$(vault read -field installation_id secret/ci/elastic-issue-crawler/github_oauth_app)
export GITHUB_OAUTH_PRIVATE_KEY=$(vault read -field private_key secret/ci/elastic-issue-crawler/github_oauth_app)

echo $ES_HOST
echo $PRIVATE_REPOS

yarn start