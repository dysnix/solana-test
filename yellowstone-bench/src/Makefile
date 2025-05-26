.PHONY: build

build:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ../bin/bench_linux_amd64 cmd/main.go
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o ../bin/bench_linux_arm64 cmd/main.go
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o ../bin/bench_darwin_arm64 cmd/main.go
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -o ../bin/bench_darwin_amd64 cmd/main.go
