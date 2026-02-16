FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY fanout-service/go.mod fanout-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY fanout-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /fanout-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /fanout-service /fanout-service

ENTRYPOINT ["/fanout-service"]
