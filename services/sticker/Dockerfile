FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY services/sticker/go.mod services/sticker/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY services/sticker/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /sticker-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /sticker-service /sticker-service

ENTRYPOINT ["/sticker-service"]
