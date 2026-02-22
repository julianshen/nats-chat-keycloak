FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY app-registry-service/go.mod app-registry-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY app-registry-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /app-registry-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /app-registry-service /app-registry-service

ENTRYPOINT ["/app-registry-service"]
