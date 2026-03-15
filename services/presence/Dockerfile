FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY services/presence/go.mod services/presence/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY services/presence/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /presence-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /presence-service /presence-service

ENTRYPOINT ["/presence-service"]
