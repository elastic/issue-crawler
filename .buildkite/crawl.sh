#!/bin/sh

# The GH repo is not needed since the github-issue crawler code is contained within the issue-crawler image
export BUILDKITE_REPO=""

ES_HOST=$(vault read -field host secret/ci/elastic-issue-crawler/github-stats-user)
ES_USER=$(vault read -field user secret/ci/elastic-issue-crawler/github-stats-user)
ES_PASSWORD=$(vault read -field password secret/ci/elastic-issue-crawler/github-stats-user)
GITHUB_OAUTH_APP_ID=$(vault read -field app_id secret/ci/elastic-issue-crawler/github_oauth_app)
GITHUB_OAUTH_INSTALLATION_ID=$(vault read -field installation_id secret/ci/elastic-issue-crawler/github_oauth_app)
GITHUB_OAUTH_PRIVATE_KEY=$(vault read -field private_key secret/ci/elastic-issue-crawler/github_oauth_app)

echo $ES_HOST
echo $PRIVATE_REPOS

yarn start