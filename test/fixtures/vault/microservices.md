---
title: Microservices
tags:
  - architecture
  - backend
---

# Microservices

Our microservices architecture consists of several independent services.

## Services

- [[user-service]] — handles authentication and user profiles
- [[order-service]] — manages orders and payments
- [[notification-service]] — sends emails and push notifications

Each service communicates via [[event-driven]] message queues.

## Deployment

Services are deployed using containers. See [[deployment-guide]] for details.

#backend #infrastructure
