.PHONY: index build test serve

index:
	npm run index -- --force

build:
	npm run build

test:
	npm run test

serve:
	npm run serve

rebuild-irdb:
	node scripts/build-index.mjs --force

rebuild-lirc:
	node scripts/build-lirc-index.mjs --force

rebuild-all: rebuild-irdb rebuild-lirc
