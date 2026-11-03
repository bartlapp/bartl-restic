FROM --platform=linux/amd64 docker.io/restic/restic:0.19.1@sha256:08916bcda4a4435f9d9828ebb4e91bb7ada3d2c8a53699788930e0ae1bd4fa67 AS runtime

# Debian supplies the collector's tooling; application build flags stay unchanged.
FROM --platform=linux/amd64 docker.io/library/golang:1.25.3@sha256:6d4e5e74f47db00f7f24da5f53c1b4198ae46862a47395e30477365458347bf2 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
# Pinned collector source: https://github.com/google/go-licenses/tree/v2.0.1
RUN go install github.com/google/go-licenses/v2@v2.0.1
COPY LICENSE NOTICE ./
COPY api ./api
COPY internal ./internal
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /bartl-restic-controller ./cmd/controller && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /bartl-restic-worker ./cmd/worker

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go-licenses save ./cmd/controller ./cmd/worker --save_path=/out/licenses/go \
    && mkdir -p /out/licenses/golang \
    && cp /usr/local/go/LICENSE /usr/local/go/PATENTS /out/licenses/golang/

# Inspect the existing container binary, never rebuild or replace it.
# Its embedded metadata specifies Go 1.26.4, CGO_ENABLED=0 and the tags below.
# Matching source: https://github.com/restic/restic/tree/v0.19.1
# Blazer's Apache notice and Fuse's composite BSD/ISC text are retained verbatim
# below because the collector cannot classify those two upstream LICENSE files.
COPY --from=runtime /usr/bin/restic /out/restic
RUN export GOTOOLCHAIN=go1.26.4 \
    && go mod download github.com/restic/restic@v0.19.1 \
    && cd /go/pkg/mod/github.com/restic/restic@v0.19.1 \
    && export GOROOT="$(go env GOROOT)" \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS="-tags=selfupdate,disable_grpc_modules" \
       go-licenses save ./cmd/restic --save_path=/out/licenses/restic \
       --ignore=github.com/Backblaze/blazer,github.com/anacrolix/fuse \
    && mkdir -p /out/licenses/restic/github.com/Backblaze/blazer /out/licenses/restic/github.com/anacrolix/fuse \
    && cp "$(go list -m -f '{{.Dir}}' github.com/Backblaze/blazer)/LICENSE" /out/licenses/restic/github.com/Backblaze/blazer/ \
    && cp "$(go list -m -f '{{.Dir}}' github.com/anacrolix/fuse)/LICENSE" /out/licenses/restic/github.com/anacrolix/fuse/ \
    && mkdir -p /out/licenses/restic/golang \
    && cp "$(go env GOROOT)/LICENSE" "$(go env GOROOT)/PATENTS" /out/licenses/restic/golang/ \
    && go version -m /out/restic > /out/licenses/restic-build.txt

FROM runtime
ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
COPY LICENSE NOTICE /usr/share/licenses/bartl-restic/
COPY --from=build /out/licenses/ /usr/share/licenses/bartl-restic/
COPY --from=build /bartl-restic-controller /bartl-restic-controller
COPY --from=build /bartl-restic-worker /bartl-restic-worker
ENTRYPOINT ["/bartl-restic-controller"]
