# PolyPatronBot — Docker management
IMAGE_NAME := "polypatronbot"
DOCKER_USER := "bglglzd"

# Default: show help
default: help

help:
	@just --list --unsorted

# Build image
build:
	docker build -t {{IMAGE_NAME}}:latest .

# Run locally (paper trading mode, dashboard on 3000)
run:
	docker run -d -p 3000:3000 --name {{IMAGE_NAME}} {{IMAGE_NAME}}:latest

# Logs
logs:
	docker logs -f {{IMAGE_NAME}}

# Stop & remove
stop:
	docker stop {{IMAGE_NAME}} 2>/dev/null || true
	docker rm {{IMAGE_NAME}} 2>/dev/null || true

# Restart
restart: stop build run

# Docker Hub push flow
login:
	docker login

tag:
	docker tag {{IMAGE_NAME}}:latest {{DOCKER_USER}}/{{IMAGE_NAME}}:latest

push: tag
	docker push {{DOCKER_USER}}/{{IMAGE_NAME}}:latest

build-and-push: build login push
	@echo "Pushed {{DOCKER_USER}}/{{IMAGE_NAME}}:latest"

# Clean
clean:
	docker stop {{IMAGE_NAME}} 2>/dev/null || true
	docker rm {{IMAGE_NAME}} 2>/dev/null || true
	docker rmi {{IMAGE_NAME}}:latest 2>/dev/null || true
	docker rmi {{DOCKER_USER}}/{{IMAGE_NAME}}:latest 2>/dev/null || true
	@echo "Cleaned"
