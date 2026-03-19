FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY services/media-server/go.mod ./
COPY pkg/mediatoken/ /pkg/mediatoken/
RUN go mod download

COPY services/media-server/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /media-server .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates && mkdir -p /data/uploads

COPY --from=builder /media-server /media-server

ENTRYPOINT ["/media-server"]
