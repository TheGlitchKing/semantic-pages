---
title: Deployment Guide
tags:
  - devops
  - infrastructure
---

# Deployment Guide

## Prerequisites

- Docker installed
- kubectl configured
- Access to the container registry

## Steps

1. Build the Docker image
2. Push to registry
3. Apply Kubernetes manifests
4. Verify health checks

## Rollback

If something goes wrong, use `kubectl rollout undo` to revert.

See [[microservices]] for service-specific deployment notes.

#devops #kubernetes
