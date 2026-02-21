FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY sticker-service/go.mod sticker-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY sticker-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /sticker-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /sticker-service /sticker-service

ENTRYPOINT ["/sticker-service"]
