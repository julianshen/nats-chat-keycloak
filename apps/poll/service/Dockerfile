FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY apps/poll/service/go.mod apps/poll/service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY apps/poll/service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /poll-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /poll-service /poll-service

ENTRYPOINT ["/poll-service"]
