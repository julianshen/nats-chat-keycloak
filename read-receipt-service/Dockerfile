FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY read-receipt-service/go.mod read-receipt-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY read-receipt-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /read-receipt-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /read-receipt-service /read-receipt-service

ENTRYPOINT ["/read-receipt-service"]
