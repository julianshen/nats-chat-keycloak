FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY services/read-receipt/go.mod services/read-receipt/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY services/read-receipt/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /read-receipt-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /read-receipt-service /read-receipt-service

ENTRYPOINT ["/read-receipt-service"]
