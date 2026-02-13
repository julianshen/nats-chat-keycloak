FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY auth-service/go.mod auth-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY auth-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /auth-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /auth-service /auth-service

ENTRYPOINT ["/auth-service"]
