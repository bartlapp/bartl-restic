FROM docker.io/library/golang:1.25.3-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY api ./api
COPY internal ./internal
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /bartl-restic-controller ./cmd/controller && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /bartl-restic-worker ./cmd/worker

FROM docker.io/restic/restic:0.19.1
COPY --from=build /bartl-restic-controller /bartl-restic-controller
COPY --from=build /bartl-restic-worker /bartl-restic-worker
ENTRYPOINT ["/bartl-restic-controller"]
