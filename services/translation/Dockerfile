FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY services/translation/go.mod services/translation/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY services/translation/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /translation-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /translation-service /translation-service

ENTRYPOINT ["/translation-service"]
