FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY presence-service/go.mod presence-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY presence-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /presence-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /presence-service /presence-service

ENTRYPOINT ["/presence-service"]
