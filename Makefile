.DEFAULT_GOAL := help
IMAGE_NAME ?= issue-crawler
REGISTRY_PATH ?= docker.elastic.co/employees/timroes

SOURCE_COMMIT := $(shell git rev-parse HEAD)
UNIQUE_TAG := $(shell printf '%s.%s' "$$(date -u +%Y%m%d%H%M)" "$$(echo "${SOURCE_COMMIT}" | cut -c -12)")

.PHONY: docker-build
docker-build:  ## Build the Docker image
	docker build --no-cache \
		--build-arg "SOURCE_COMMIT=${SOURCE_COMMIT}" \
		--tag ${IMAGE_NAME} .

.PHONY: clean
clean:  ## Remove all local Docker images
clean: IMAGE_ID = $(shell docker image ls --format '{{ .ID }}' ${IMAGE_NAME}:latest)
clean:
	docker image rm --force ${IMAGE_ID}

.PHONY: docker-push
docker-push:  ## Push the local Docker image to our private registry
docker-push: docker-tag
	docker push "${REGISTRY_PATH}/${IMAGE_NAME}:latest"
	docker push "${REGISTRY_PATH}/${IMAGE_NAME}:${UNIQUE_TAG}"

.PHONY: docker-tag
docker-tag:  ## Tag the local Docker image for our private registryy
docker-tag: docker-build
	# unique tag
	docker tag ${IMAGE_NAME} "${REGISTRY_PATH}/${IMAGE_NAME}:${UNIQUE_TAG}"
	# stable tags
	docker tag ${IMAGE_NAME} "${REGISTRY_PATH}/${IMAGE_NAME}:latest"
	docker image ls "${REGISTRY_PATH}/${IMAGE_NAME}"

.PHONY: help
help:  ## Show this help message
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

