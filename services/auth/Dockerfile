FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY services/auth/go.mod services/auth/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY services/auth/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /auth-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /auth-service /auth-service

ENTRYPOINT ["/auth-service"]
