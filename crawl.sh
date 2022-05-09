#!/bin/sh

export ES_HOST=$(vault read -field host $ES_CLUSTER_INFO_VAULT_PATH)
export ES_USER=$(vault read -field user $ES_CLUSTER_INFO_VAULT_PATH)
export ES_PASSWORD=$(vault read -field password $ES_CLUSTER_INFO_VAULT_PATH)
export GITHUB_OAUTH_APP_ID=$(vault read -field app_id $GITHUB_OAUTH_APP_VAULT_PATH)
export GITHUB_OAUTH_INSTALLATION_ID=$(vault read -field installation_id $GITHUB_OAUTH_APP_VAULT_PATH)
export GITHUB_OAUTH_PRIVATE_KEY=$(vault read -field private_key $GITHUB_OAUTH_APP_VAULT_PATH)

yarn install && yarn cache clean

yarn start