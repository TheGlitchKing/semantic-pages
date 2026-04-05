---
title: API Gateway
tags:
  - architecture
  - api
---

# API Gateway

The API gateway is the single entry point for all client requests.

## Responsibilities

- Route requests to appropriate [[microservices]]
- Handle authentication via JWT tokens
- Rate limiting
- Request/response transformation

## Endpoints

| Method | Path | Service |
|--------|------|---------|
| GET | /api/users | [[user-service]] |
| POST | /api/orders | [[order-service]] |
| GET | /api/notifications | [[notification-service]] |

#api #gateway
