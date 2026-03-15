FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY services/fanout/go.mod services/fanout/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY services/fanout/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /fanout-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /fanout-service /fanout-service

ENTRYPOINT ["/fanout-service"]
