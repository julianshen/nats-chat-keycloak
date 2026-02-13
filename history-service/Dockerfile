FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY history-service/go.mod history-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY history-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /history-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /history-service /history-service

ENTRYPOINT ["/history-service"]
