FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY services/app-registry/go.mod services/app-registry/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY services/app-registry/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /app-registry-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /app-registry-service /app-registry-service

ENTRYPOINT ["/app-registry-service"]
