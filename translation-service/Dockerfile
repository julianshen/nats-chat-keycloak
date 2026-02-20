FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY translation-service/go.mod translation-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY translation-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /translation-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /translation-service /translation-service

ENTRYPOINT ["/translation-service"]
