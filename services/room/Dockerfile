FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY services/room/go.mod services/room/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY services/room/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /room-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /room-service /room-service

ENTRYPOINT ["/room-service"]
