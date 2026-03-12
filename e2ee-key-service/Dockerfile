FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY e2ee-key-service/go.mod e2ee-key-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY e2ee-key-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /e2ee-key-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates && \
    adduser -D -u 10001 appuser

COPY --from=builder /e2ee-key-service /e2ee-key-service

USER appuser

ENTRYPOINT ["/e2ee-key-service"]
