FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY persist-worker/go.mod persist-worker/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY persist-worker/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /persist-worker .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /persist-worker /persist-worker

ENTRYPOINT ["/persist-worker"]
