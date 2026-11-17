.PHONY: index build test serve

index:
	npm run index

build:
	npm run build

test:
	npm run test

serve:
	npm run serve

rebuild-irdb:
	node scripts/build-index.mjs

rebuild-lirc:
	node scripts/build-lirc-index.mjs

rebuild-all: rebuild-irdb rebuild-lirc
