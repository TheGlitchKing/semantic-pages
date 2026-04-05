---
title: Event-Driven Architecture
tags:
  - architecture
  - patterns
---

# Event-Driven Architecture

Events are the backbone of our system. When something happens in one service,
it publishes an event that other services can react to.

## Key Concepts

- **Event** — a record of something that happened
- **Publisher** — the service that emits an event
- **Subscriber** — a service that listens for events
- **Event Bus** — the transport layer (we use RabbitMQ)

See [[microservices]] for how services use events.
See [[project-overview]] for the big picture.

#patterns #messaging
