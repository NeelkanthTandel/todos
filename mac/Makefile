# Common tasks for the Mac app. Run `make help` for a list.

.PHONY: help build test lint format app dmg run-dev clean

help:
	@echo "make build     Debug build"
	@echo "make test      Run unit tests"
	@echo "make lint      Check formatting (swift format lint)"
	@echo "make format    Fix formatting in place"
	@echo "make app       Release build -> build/Todos.app"
	@echo "make dmg       make app, then pack build/Todos.dmg"
	@echo "make run-dev   Run a debug build that serves ../public straight from the repo"
	@echo "make clean     Remove build products"

build:
	swift build

test:
	swift test

lint:
	swift format lint --strict --recursive --configuration .swift-format Sources Tests Package.swift

format:
	swift format format --in-place --recursive --configuration .swift-format Sources Tests Package.swift

app:
	scripts/build_app.sh

dmg: app
	scripts/make_dmg.sh

# Edits to ../public show up on reload (⌘R isn't bound; quit and rerun). Uses the same storage as the built app.
run-dev: build
	TODOS_WEB_DIR="$(CURDIR)/../public" TODOS_INSPECT=1 "$$(swift build --show-bin-path)/Todos"

clean:
	rm -rf .build build
