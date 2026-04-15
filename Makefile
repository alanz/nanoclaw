NANOCLAW_XDC_SRCS := $(wildcard webxdc-src/*)
TODO_XDC_SRCS     := $(wildcard apps/todo-app/*)

assets/nanoclaw.xdc: $(NANOCLAW_XDC_SRCS)
	bash scripts/build-webxdc.sh

assets/todo.xdc: $(TODO_XDC_SRCS)
	bash scripts/build-todo-xdc.sh
