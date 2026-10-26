CFLAGS = -std=c11 -O2 -Wall -Wextra

bench: bench.c intern.c intern.h
	$(CC) $(CFLAGS) -o $@ bench.c intern.c

.PHONY: run
run: bench
	./bench
